// api/checkout.js
//
// Vercel serverless function. Runs on Vercel's server, never in the
// browser — this is where the Sitevento API key belongs.
//
// Set SITEVENTO_API_KEY in your Vercel project:
//   Project -> Settings -> Environment Variables
//   Name: SITEVENTO_API_KEY
//   Value: sv_test_... (or sv_live_... later)
// Redeploy after adding it. Locally, put it in a .env file (see
// .env.example) and it'll be picked up by `vercel dev`.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const apiKey = process.env.SITEVENTO_API_KEY;
  if (!apiKey) {
    console.error('[checkout] Missing SITEVENTO_API_KEY env var');
    return res.status(500).json({ ok: false, error: 'Server not configured.' });
  }

  const {
    items,        // [{ name, price, qty, category }]
    total,
    subtotal,
    discount,
    couponCode,
    shipping,
    paymentMethod,
    customerId,
    customerEmail,
    visitorId,
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0 || typeof total !== 'number') {
    return res.status(400).json({ ok: false, error: 'items[] and numeric total are required.' });
  }

  try {
    const ingestRes = await fetch('https://sitevento12.vercel.app/api/ingest', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event: 'purchase',
        userId: customerId || undefined,
        visitorId: visitorId || undefined,
        orderTotal: total,
        subtotal,
        discount: discount || 0,
        couponCode: couponCode || null,
        shipping: shipping || 0,
        paymentMethod: paymentMethod || 'card',
        customerEmail: customerEmail || null,
        itemCount: items.reduce((n, it) => n + (it.qty || 1), 0),
        items: items.map((it) => ({
          name: it.name,
          price: it.price,
          qty: it.qty || 1,
          category: it.category || null,
        })),
      }),
    });

    const ingestData = await ingestRes.json().catch(() => ({}));

    if (!ingestRes.ok) {
      console.error('[checkout] Sitevento ingest failed', ingestRes.status, ingestData);
      // Still let the "purchase" succeed for the shopper — analytics
      // failing shouldn't block a sale. Just report it wasn't tracked,
      // with enough detail to show in the UI log (status + whatever
      // message Sitevento returned, never the key itself).
      return res.status(200).json({
        ok: true,
        tracked: false,
        order: { items, total },
        trackError: `Sitevento ${ingestRes.status}: ${ingestData.error || 'request rejected'}`,
      });
    }

    return res.status(200).json({ ok: true, tracked: true, order: { items, total }, sitevento: ingestData });
  } catch (err) {
    console.error('[checkout] Network error calling Sitevento', err);
    return res.status(200).json({
      ok: true,
      tracked: false,
      order: { items, total },
      trackError: 'Could not reach Sitevento (network error).',
    });
  }
}
