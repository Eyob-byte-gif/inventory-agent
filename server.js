require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
mongoose.set('bufferTimeoutMS', 8000); // fail fast instead of hanging

const MAX_STEPS = 5; // cap on tool-call rounds per request
const MOVEMENTS = ['sale', 'delivery', 'return'];

// ---------- Data ----------
const Product = mongoose.model('Product', new mongoose.Schema({
  code: { type: String, unique: true }, name: String, unit: String, stock: Number,
}));
const Txn = mongoose.model('Txn', new mongoose.Schema({
  code: String, name: String, movement: String, quantity: Number,
  unit: String, before: Number, after: Number,
}, { timestamps: true }));

// ---------- Tool 1: find products ----------
async function findProducts({ query }) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { error: 'Empty search query' };
  const all = await Product.find().lean();
  const matches = all
    .map((p) => ({
      p,
      score: words.filter((w) => p.name.toLowerCase().includes(w) || p.code.toLowerCase() === w).length,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => ({ code: x.p.code, name: x.p.name }));
  return { matches };
}

// ---------- Tool 2: check stock ----------
async function checkStock({ code }) {
  const p = await Product.findOne({ code: String(code) }).lean();
  if (!p) return { error: `Unknown product code ${code}` };
  return { code: p.code, name: p.name, quantity: p.stock, unit: p.unit };
}

// ---------- Tool 3: record transaction ----------
// confirmed=false -> validate + preview only. confirmed=true -> save.
async function recordTransaction({ code, movement, quantity }, confirmed = false) {
  const qty = Number(quantity);
  if (!MOVEMENTS.includes(movement)) return { error: 'movement must be sale, delivery or return' };
  if (!Number.isInteger(qty) || qty <= 0) return { error: 'quantity must be a positive whole number' };
  const p = await Product.findOne({ code: String(code) });
  if (!p) return { error: `Unknown product code ${code}` };

  const delta = movement === 'sale' ? -qty : qty;
  if (p.stock + delta < 0) {
    return { error: `Rejected: only ${p.stock} ${p.unit} in stock, cannot sell ${qty}` };
  }
  const preview = {
    code: p.code, name: p.name, movement, quantity: qty,
    unit: p.unit, before: p.stock, after: p.stock + delta,
  };
  if (!confirmed) return { preview: true, ...preview };

  const filter = movement === 'sale' ? { code: p.code, stock: { $gte: qty } } : { code: p.code };
  const updated = await Product.findOneAndUpdate(filter, { $inc: { stock: delta } }, { new: true });
  if (!updated) return { error: 'Stock changed meanwhile. Please retry.' };
  const t = await Txn.create({ ...preview, before: updated.stock - delta, after: updated.stock });
  return { saved: true, id: String(t._id), ...preview, before: t.before, after: t.after };
}

// ---------- Groq (OpenAI-compatible tool calling) ----------
const SYSTEM =
  'You are a stock controller. Handle ONE sale, delivery or return per request. ' +
  'Always call find_products first. If several products match or the quantity is missing/unclear, ask the user to clarify. ' +
  'Then call check_stock. Then call record_transaction to propose the movement; it only creates a preview and the user confirms in the UI. ' +
  'Never invent product codes or stock numbers. Be brief. ' +
  'Never judge or refuse quantities yourself. Even if the quantity exceeds stock, still call record_transaction and let the system validate it and report the result.';

const fn = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const TOOLS = [
  fn('find_products', 'Search products by name keywords. Returns matching names and unique codes.',
    { query: { type: 'string' } }, ['query']),
  fn('check_stock', 'Get current quantity and unit for a product code.',
    { code: { type: 'string' } }, ['code']),
  fn('record_transaction', 'Propose ONE stock movement (sale, delivery or return). Creates a preview only.',
    { code: { type: 'string' }, movement: { type: 'string', enum: MOVEMENTS }, quantity: { type: 'number' } },
    ['code', 'movement', 'quantity']),
];

async function callGroq(messages, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(25000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.GROQ_API_KEY,
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
          messages, tools: TOOLS, tool_choice: 'auto', temperature: 0.2,
        }),
      });
      if (r.ok) return (await r.json()).choices[0].message;
      const err = new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
      err.status = r.status;
      throw err;
    } catch (e) {
      const retryable = [429, 500, 503].includes(e.status) || e.name === 'TimeoutError';
      if (i >= tries || !retryable) throw e;
      await new Promise((ok) => setTimeout(ok, 2000 * i));
    }
  }
}

async function runTool(name, args) {
  try {
    if (name === 'find_products') return await findProducts(args);
    if (name === 'check_stock') return await checkStock(args);
    if (name === 'record_transaction') return await recordTransaction(args, false);
    return { error: `Unknown tool ${name}` };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------- Routes ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 });
});

app.post('/api/chat', async (req, res) => {
  try {
    const turns = Array.isArray(req.body.messages) ? req.body.messages : [];
    const last = turns[turns.length - 1];
    if (!last || !String(last.text || '').trim()) {
      return res.status(400).json({ error: 'Please type an instruction.' });
    }
    const msgs = [
      { role: 'system', content: SYSTEM },
      ...turns.map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', content: String(t.text) })),
    ];
    const log = [];

    for (let step = 0; step < MAX_STEPS; step++) {
      const m = await callGroq(msgs);
      const calls = m.tool_calls;
      if (!calls || !calls.length) {
        return res.json({ reply: m.content || '(no reply)', log });
      }
      msgs.push({ role: 'assistant', content: m.content || '', tool_calls: calls });
      for (const c of calls) {
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* bad JSON from model */ }
        const out = await runTool(c.function.name, args);
        log.push({ tool: c.function.name, args, result: out });
        if (c.function.name === 'record_transaction' && out.preview) {
          const reply =
            `Please confirm: ${out.movement} of ${out.quantity} ${out.unit} of ${out.name} (${out.code}). ` +
            `Stock ${out.before} -> ${out.after} ${out.unit}.`;
          return res.json({
            reply, log,
            pending: { code: out.code, movement: out.movement, quantity: out.quantity },
          });
        }
        msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out) });
      }
    }
    res.json({ reply: 'That took too many steps. Please rephrase with one clear instruction.', log });
  } catch (e) {
    const quota = /429/.test(e.message);
    res.status(quota ? 429 : 500).json({
      error: quota ? 'AI quota reached. Please wait a minute and retry.' : 'Something went wrong: ' + e.message,
    });
  }
});

app.post('/api/confirm', async (req, res) => {
  try {
    const out = await recordTransaction(req.body || {}, true);
    res.status(out.error ? 400 : 200).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/transactions', async (_req, res) => {
  try {
    res.json(await Txn.find().sort({ createdAt: -1 }).limit(50).lean());
  } catch (e) {
    res.status(500).json({ error: 'Database not reachable: ' + e.message });
  }
});

app.get('/api/transactions/:id', async (req, res) => {
  try {
    const t = await Txn.findById(req.params.id).lean();
    t ? res.json(t) : res.status(404).json({ error: 'Not found' });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// ---------- Start: listen first, connect DB in background ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port ' + PORT));
mongoose
  .connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => console.log('DB connected'))
  .catch((e) => console.error('DB connection failed:', e.message));
