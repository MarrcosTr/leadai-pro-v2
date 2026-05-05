// api/search.js — Vercel Serverless Function
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });

  const { niche, city, minRating, minReviews, serpKey, geminiKey } = req.body;

  if (!niche || !city || !serpKey || !geminiKey) {
    return res.status(400).json({ error: "Parâmetros obrigatórios faltando" });
  }

  // Modelos Gemini em ordem de tentativa
  const GEMINI_MODELS = [
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-flash-latest",
    "gemini-pro"
  ];

  async function callGemini(prompt, geminiKey) {
    for (const model of GEMINI_MODELS) {
      try {
        const gemRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
            })
          }
        );
        if (!gemRes.ok) continue;
        const gemData = await gemRes.json();
        if (gemData.error) continue;
        const raw = gemData.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (!raw) continue;
        // Remove markdown backticks
        const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
        // Extrai JSON se vier com texto ao redor
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) continue;
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed;
      } catch (e) {
        continue;
      }
    }
    return null;
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
    }).slice(0, 15);

    if (places.length === 0) {
      return res.status(200).json({ leads: [], message: "Nenhum resultado encontrado com esses filtros." });
    }

    // 2. Analisa cada lead com Gemini
    const leads = await Promise.all(places.map(async (place, idx) => {
      const reviews = (place.reviews_data || []).slice(0, 5).map(r => r.snippet || "").filter(Boolean);
      const reviewsText = reviews.length > 0 ? reviews.join(" | ") : "Sem avaliações detalhadas disponíveis.";
      const snippet = place.description || place.type || "";

      const prompt = `Você é especialista em prospecção B2B. Analise este negócio e retorne SOMENTE JSON válido, sem markdown, sem texto adicional.

Negócio: ${place.title}
Segmento: ${niche}
Cidade: ${city}
Nota: ${place.rating} estrelas (${place.reviews} avaliações)
Descrição: ${snippet}
Avaliações recentes: ${reviewsText}

JSON de resposta (exatamente este formato):
{"ai_score":75,"score_label":"Morno ⚡","pain_points":["dor específica 1","dor específica 2","dor específica 3"],"ai_message":"Mensagem de prospecção personalizada de 2 frases mencionando uma dor real identificada nas avaliações"}

Regras:
- ai_score: 80-100 = muitas dores/oportunidade clara, 60-79 = algumas oportunidades, 40-59 = poucos sinais, 0-39 = negócio bem estruturado
- score_label: "Quente 🔥" se >=80, "Morno ⚡" se >=60, "Frio ❄️" se <60
- pain_points: dores REAIS baseadas nas avaliações, não genéricas
- ai_message: mencione o nome do negócio e uma dor específica real`;

      const aiResult = await callGemini(prompt, geminiKey);

      if (aiResult && aiResult.ai_score !== undefined) {
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
          ai_score: Math.min(100, Math.max(0, aiResult.ai_score || 50)),
          score_label: aiResult.score_label || "Morno ⚡",
          pain_points: Array.isArray(aiResult.pain_points) ? aiResult.pain_points : [],
          ai_message: aiResult.ai_message || "",
          history: [
            { type: "extracted", label: "Lead extraído via Google Maps", ts: Date.now() },
            { type: "ai", label: `Score de IA gerado: ${aiResult.ai_score || 50} pts`, ts: Date.now() + 1000 }
          ]
        };
      }

      // Fallback se Gemini falhar completamente
      const fallbackScore = Math.round(
        (parseFloat(place.rating) <= 3.5 ? 75 : parseFloat(place.rating) <= 4.2 ? 60 : 45) +
        Math.random() * 10
      );
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
        ai_score: fallbackScore,
        score_label: fallbackScore >= 80 ? "Quente 🔥" : fallbackScore >= 60 ? "Morno ⚡" : "Frio ❄️",
        pain_points: ["presença digital limitada", "atendimento pode melhorar", "captação de clientes"],
        ai_message: `Olá, ${place.title}! Vi que vocês têm ${place.reviews} avaliações no Google Maps e acredito que posso ajudar a atrair ainda mais clientes para o seu negócio em ${city}. Posso te mostrar como em 5 minutos?`,
        history: [
          { type: "extracted", label: "Lead extraído via Google Maps", ts: Date.now() }
        ]
      };
    }));

    return res.status(200).json({ leads });

  } catch (err) {
    console.error("Erro na busca:", err);
    return res.status(500).json({ error: err.message || "Erro interno no servidor" });
  }
}
