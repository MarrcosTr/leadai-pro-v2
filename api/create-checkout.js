// api/create-checkout.js — Cria cobrança no Asaas e retorna link de pagamento
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido" });

  const ASAAS_KEY = process.env.ASAAS_API_KEY;
  if (!ASAAS_KEY) return res.status(500).json({ error: "Chave Asaas não configurada no servidor" });

  const ASAAS_BASE = "https://api.asaas.com/v3";

  const { planId, customerName, customerEmail, customerCpfCnpj } = req.body;
  if (!planId || !customerEmail) {
    return res.status(400).json({ error: "planId e customerEmail são obrigatórios" });
  }

  const PLAN_INFO = {
    starter: { name: "LeadAI Pro — Starter", value: 67,  description: "100 leads/mês + IA completa" },
    pro:     { name: "LeadAI Pro — Pro",     value: 147, description: "500 leads/mês + IA premium" },
  };
  const plan = PLAN_INFO[planId];
  if (!plan) return res.status(400).json({ error: "Plano inválido" });

  try {
    // 1. Busca ou cria cliente no Asaas
    let customerId = null;

    const searchRes = await fetch(
      `${ASAAS_BASE}/customers?email=${encodeURIComponent(customerEmail)}`,
      { headers: { "access_token": ASAAS_KEY } }
    );
    const searchData = await searchRes.json();

    if (searchData.data && searchData.data.length > 0) {
      customerId = searchData.data[0].id;
    } else {
      const createRes = await fetch(`${ASAAS_BASE}/customers`, {
        method: "POST",
        headers: { "access_token": ASAAS_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: customerName || customerEmail.split("@")[0],
          email: customerEmail,
          cpfCnpj: customerCpfCnpj || undefined,
          notificationDisabled: false,
        })
      });
      const createData = await createRes.json();
      if (createData.errors) throw new Error(createData.errors[0]?.description || "Erro ao criar cliente");
      customerId = createData.id;
    }

    // 2. Cria link de pagamento com todos os campos obrigatórios
    const linkRes = await fetch(`${ASAAS_BASE}/paymentLinks`, {
      method: "POST",
      headers: { "access_token": ASAAS_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: plan.name,
        description: plan.description,
        value: plan.value,
        billingType: "UNDEFINED",
        chargeType: "RECURRENT",
        subscriptionCycle: "MONTHLY",
        dueDateLimitDays: 5,
        maxInstallmentCount: 6,
        notificationEnabled: true,
        callback: {
          successUrl: `https://leadai-pro-v2.vercel.app/?payment=success&plan=${planId}&email=${encodeURIComponent(customerEmail)}`,
          autoRedirect: true
        }
      })
    });

    const linkData = await linkRes.json();
    console.log("Asaas paymentLink response:", JSON.stringify(linkData));

    if (linkData.errors && linkData.errors.length > 0) {
      throw new Error(linkData.errors[0]?.description || "Erro ao criar link de pagamento");
    }
    if (!linkData.url) {
      throw new Error("Link de pagamento não retornado: " + JSON.stringify(linkData));
    }

    return res.status(200).json({
      paymentUrl: linkData.url,
      paymentLinkId: linkData.id,
      customerId,
      plan: planId,
      email: customerEmail
    });

  } catch (err) {
    console.error("Asaas erro:", err);
    return res.status(500).json({ error: err.message || "Erro ao processar pagamento" });
  }
}
