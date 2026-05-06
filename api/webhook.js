// api/webhook.js — Recebe eventos do Asaas e libera plano no Supabase
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const SUPABASE_URL     = process.env.SUPABASE_URL     || "https://ptvkywxtrzyntjirmebv.supabase.co";
  const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY; // service_role key (não a anon!)

  try {
    const event = req.body;
    console.log("Webhook Asaas recebido:", JSON.stringify(event));

    // Só processa pagamentos confirmados/recebidos
    const PAID_EVENTS = ["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED", "PAYMENT_APPROVED_BY_RISK_ANALYSIS"];
    if (!PAID_EVENTS.includes(event.event)) {
      return res.status(200).json({ ok: true, ignored: event.event });
    }

    const payment  = event.payment;
    const email    = payment?.customer?.email;
    const linkId   = payment?.paymentLink;
    const value    = payment?.value;

    if (!email) return res.status(200).json({ ok: true, msg: "Sem email no payload" });

    // Determina plano pelo valor pago
    let plan = "free";
    if (value >= 130) plan = "pro";
    else if (value >= 60) plan = "starter";

    // Atualiza plano do usuário no Supabase (tabela user_profiles ou metadata)
    if (SUPABASE_SERVICE) {
      // Busca o usuário pelo email
      const userRes = await fetch(
        `${SUPABASE_URL}/auth/v1/admin/users?filter=email%3D%3D${encodeURIComponent(email)}`,
        {
          headers: {
            "apikey": SUPABASE_SERVICE,
            "Authorization": `Bearer ${SUPABASE_SERVICE}`
          }
        }
      );
      const userData = await userRes.json();
      const userId = userData?.users?.[0]?.id;

      if (userId) {
        // Atualiza metadata do usuário com o plano
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
          method: "PUT",
          headers: {
            "apikey": SUPABASE_SERVICE,
            "Authorization": `Bearer ${SUPABASE_SERVICE}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            user_metadata: {
              plan,
              plan_activated_at: new Date().toISOString(),
              payment_id: payment?.id
            }
          })
        });
        console.log(`Plano ${plan} ativado para ${email} (userId: ${userId})`);
      } else {
        console.log(`Usuário não encontrado para email: ${email}`);
      }
    } else {
      // Sem service key: apenas loga (você ativa manualmente no Supabase Dashboard)
      console.log(`PAGAMENTO RECEBIDO — Email: ${email} | Plano: ${plan} | Valor: R$${value} | ID: ${payment?.id}`);
    }

    return res.status(200).json({ ok: true, plan, email });

  } catch (err) {
    console.error("Webhook erro:", err);
    return res.status(500).json({ error: err.message });
  }
}
