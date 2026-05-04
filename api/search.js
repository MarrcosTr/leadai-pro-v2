// api/search.js — Vercel Serverless Function
// Recebe: { niche, city, minRating, minReviews, serpKey, geminiKey }
// Retorna: { leads: [...] }

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });

  const { niche, city, minRating, minReviews, serpKey, geminiKey } = req.body;

  if (!niche || !city || !serpKey || !geminiKey) {
    return res.status(400).json({ error: "Parâmetros obrigatórios faltando" });
  }

  try {
    // 1. Busca no Google Maps via SerpAPI
    const serpUrl = new URL("https://serpapi.com/search");
    serpUrl.searchParams.set("engine", "google_maps");
    serpUrl.searchParams.set("q", `${niche} em ${city}`);
    serpUrl.searchParams.set("type", "search");
    serpUrl.searchParams.set("hl", "pt");
    serpUrl.searchParams.set("gl", "br");
    serpUrl.searchParams.set("api_key", serpKey);

    const serpRes = await fetch(serpUrl.toString());
    if (!serpRes.ok) {
      const errText = await serpRes.text();
      throw new Error(`SerpAPI erro ${serpRes.status}: ${errText.slice(0, 200)}`);
    }
    const serpData = await serpRes.json();

    if (serpData.error) throw new Error(`SerpAPI: ${serpData.error}`);

    const places = (serpData.local_results || []).filter(p => {
      const rating = parseFloat(p.rating) || 0;
      const reviews = parseInt(p.reviews) || 0;
      return rating >= parseFloat(minRating) && reviews >= parseInt(minReviews);
    }).slice(0, 15); // máximo 15 para não estourar limite da Gemini

    if (places.length === 0) {
      return res.status(200).json({ leads: [], message: "Nenhum resultado encontrado com esses filtros." });
    }

    // 2. Para cada place, gera score e mensagem via Gemini
    const leads = await Promise.all(places.map(async (place, idx) => {
      const reviews = (place.reviews_data || []).slice(0, 5).map(r => r.snippet || "").filter(Boolean);
      const reviewsText = reviews.length > 0 ? reviews.join(" | ") : "Sem avaliações disponíveis.";

      const prompt = `Você é um especialista em prospecção B2B. Analise este negócio e retorne SOMENTE JSON válido, sem markdown, sem explicações.

Negócio: ${place.title}
Segmento: ${niche}
Cidade: ${city}
Nota Google: ${place.rating} (${place.reviews} avaliações)
Avaliações recentes: ${reviewsText}

Retorne este JSON exato:
{
  "ai_score": <número 0-100>,
  "score_label": "<Quente 🔥 | Morno ⚡ | Frio ❄️>",
  "pain_points": ["<dor1>","<dor2>","<dor3>"],
  "ai_message": "<mensagem de prospecção personalizada de 2-3 frases, mencionando uma dor específica das avaliações>"
}`;

      try {
        const gemRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.7, maxOutputTokens: 400 }
            })
          }
        );

        if (!gemRes.ok) throw new Error(`Gemini erro ${gemRes.status}`);
        const gemData = await gemRes.json();
        const raw = gemData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

        // Remove possíveis backticks de markdown
        const cleaned = raw.replace(/```json|```/g, "").trim();
        const aiResult = JSON.parse(cleaned);

        return {
          id: idx + 1,
          name: place.title || "Sem nome",
          segment: niche,
          city: city,
          phone: place.phone || null,
          has_whatsapp: !!place.phone,
          rating: parseFloat(place.rating) || 0,
          review_count: parseInt(place.reviews) || 0,
          website: place.website || null,
          address: place.address || "",
          maps_url: place.links?.directions || "",
          status: "new",
          ai_score: aiResult.ai_score || 50,
          score_label: aiResult.score_label || "Morno ⚡",
          pain_points: aiResult.pain_points || [],
          ai_message: aiResult.ai_message || "",
          history: [
            { type: "extracted", label: "Lead extraído via Google Maps", ts: Date.now() },
            { type: "ai", label: `Score de IA gerado: ${aiResult.ai_score || 50} pts`, ts: Date.now() + 1000 }
          ]
        };
      } catch (aiErr) {
        // Se Gemini falhar para este lead, retorna com dados básicos
        return {
          id: idx + 1,
          name: place.title || "Sem nome",
          segment: niche,
          city: city,
          phone: place.phone || null,
          has_whatsapp: !!place.phone,
          rating: parseFloat(place.rating) || 0,
          review_count: parseInt(place.reviews) || 0,
          website: place.website || null,
          address: place.address || "",
          status: "new",
          ai_score: Math.round(Math.random() * 40 + 40),
          score_label: "Morno ⚡",
          pain_points: ["análise indisponível"],
          ai_message: `Olá! Vi que seu ${niche} em ${city} tem ótimas avaliações. Tenho uma solução que pode ajudar a atrair ainda mais clientes. Posso te mostrar em 5 minutos?`,
          history: [
            { type: "extracted", label: "Lead extraído via Google Maps", ts: Date.now() }
          ]
        };
      }
    }));

    return res.status(200).json({ leads });

  } catch (err) {
    console.error("Erro na busca:", err);
    return res.status(500).json({ error: err.message || "Erro interno no servidor" });
  }
}
