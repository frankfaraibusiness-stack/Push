// api/checkout.js
//
// Vercel serverless function. Runs on Vercel's server, never in the
// browser.
//
// ⚠️ The Sitevento API key is hardcoded below as requested. This means
// anyone with access to this file / the repo can read it. For production,
// move it back to process.env.SITEVENTO_API_KEY and rotate this key.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Hardcoded API key.
  const apiKey = 'sv_live_MezP4hemk0sQzuNJHygKwpgK4W3pnB8z';
  if (!apiKey) {
    console.error('[checkout] Missing Sitevento API key');
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