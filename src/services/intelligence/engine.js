'use strict';
/**
 * NECPRA INTELLIGENCE ENGINE: the single entry point every module uses ("ask NECPRA").
 *
 *   text -> intents.recognise() -> context/follow-up/clarification -> one of:
 *     { type:'answer'   }  read-only server tool ran for the CALLER only; says what is known vs predicted
 *     { type:'action'   }  a canonical phrase for the existing on-screen voice handlers (they keep their confirmations)
 *     { type:'prepare'  }  a sensitive thing was understood but NOTHING was done; the client must show its normal confirm screen
 *     { type:'clarify'  }  ambiguous / missing detail: we ask, we do not guess
 *     { type:'unknown'  }  not understood: honest fallback, optional local-LLM adapter tried first
 *
 * Rules enforced here: the engine has no DB handle of its own (tools do, scoped by userId); it never executes a payment, a sale or a
 * message; it never claims an action succeeded; user text is data (never instructions) and is not stored or logged by this file.
 */
const crypto = require('crypto');
const { recognise } = require('./intents');
const nlp = require('./nlp');
const voiceActions = require('../voiceActions');

const CONTEXT_TTL_MS = Number(process.env.NECPRA_AI_CONTEXT_TTL_MS || 5 * 60000);
const SW_HINT = /\b(?:nina|nimeuza|nikumbushe|wateja|bidhaa|mauzo|faida|pesa|salio|tuma|fungua|kesho|leo|ngapi|hawajalipa|wanadaiwa|chama|michango|zimebaki|gharama|nimetumia)\b/i;

const T = {
  unknown: { en: "I didn't understand that. You can ask about your balance, sales, profit, stock, customers who owe you, or say \"open wallet\".", sw: 'Sijaelewa. Unaweza kuuliza kuhusu salio, mauzo, faida, stoku, wateja wanaodaiwa, au sema "fungua pochi".' },
  ask_name: { en: 'Who do you mean? Please say the name.', sw: 'Unamaanisha nani? Tafadhali sema jina.' },
  ask_amount: { en: 'How much?', sw: 'Kiasi gani?' },
  ask_to: { en: 'Who should it go to? Say a name or phone number.', sw: 'Itumwe kwa nani? Sema jina au namba ya simu.' },
  ask_product: { en: 'Which product?', sw: 'Bidhaa gani?' },
  ask_task: { en: 'What should I remind you about?', sw: 'Nikukumbushe nini?' },
  reminder_past: { en: 'That time has already passed. Please give a time in the future.', sw: 'Muda huo umeshapita. Tafadhali taja muda ujao.' },
  reminder_limit: { en: 'You have too many active reminders. Please finish or cancel some first.', sw: 'Una vikumbusho vingi sana. Tafadhali maliza au ghairi vingine kwanza.' },
  ask_when: { en: 'When should I remind you? For example "tomorrow".', sw: 'Nikukumbushe lini? Kwa mfano "kesho".' },
  ask_items_text: { en: 'What did you sell, and how many?', sw: 'Uliuza nini, na ngapi?' },
  cannot_period: { en: 'I can do that only for today, this week or this month.', sw: 'Naweza kufanya hivyo kwa leo, wiki hii au mwezi huu tu.' },
  confirm_first: { en: 'I have not done anything yet. Please confirm on the screen.', sw: 'Sijafanya chochote bado. Tafadhali thibitisha kwenye skrini.' },
  tool_failed: { en: 'I could not get that right now. Please try again in a moment.', sw: 'Sijaweza kupata hilo sasa. Tafadhali jaribu tena baadaye.' },
  rate: { en: 'You are asking very quickly. Please wait a moment.', sw: 'Unauliza haraka sana. Tafadhali subiri kidogo.' }
};
const say = (k, lang) => (lang === 'sw' ? T[k].sw : T[k].en);
const pickLang = (text, hint) => (/^sw/i.test(String(hint || '')) || SW_HINT.test(String(text || '')) ? 'sw' : 'en');
const MISSING_Q = { name: 'ask_name', amount: 'ask_amount', to: 'ask_to', product: 'ask_product', when: 'ask_when', task: 'ask_task', items_text: 'ask_items_text' };

function createEngine(deps = {}) {
  const tools = deps.tools;                       // { run(name,args) }
  const reminders = deps.reminders || null;       // optional personal-reminders store (see reminders.js)
  const llm = deps.llm || null;                   // optional local adapter: async ({text, catalogue}) -> { action, slots, confidence }
  const store = deps.contextStore || new Map();   // userId -> { lastIntent, lastSlots, pending, at }
  const now = deps.now || (() => Date.now());

  const getCtx = (uid) => { const c = store.get(uid); if (c && now() - c.at > CONTEXT_TTL_MS) { store.delete(uid); return null; } return c || null; };
  const setCtx = (uid, patch) => { const c = Object.assign({}, getCtx(uid) || {}, patch, { at: now() }); store.set(uid, c); if (store.size > 5000) { for (const [k, v] of store) { if (now() - v.at > CONTEXT_TTL_MS) store.delete(k); if (store.size <= 4000) break; } } return c; };
  const clear = (uid) => store.delete(uid);

  function uiResult(rec, lang, extra) {
    const built = voiceActions.buildPhrase(rec.ui, rec.slots);
    if (!built) return null;
    return Object.assign({ type: rec.sensitive ? 'prepare' : 'action', intent: rec.intent, confidence: rec.confidence, phrase: built.phrase, module: built.module, sensitive: !!rec.sensitive,
      requiresConfirmation: !!rec.sensitive, say: rec.sensitive ? say('confirm_first', lang) : undefined, note: rec.note || undefined }, extra || {});
  }

  /**
   * @param {{userId:number|string, text:string, lang?:string, page?:string, shopId?:string}} req
   * @returns {Promise<object>} always resolves; never throws
   */
  async function handle(req) {
    const userId = req && req.userId;
    if (userId == null) return { type: 'error', error: 'unauthorized' };
    const text = String((req && req.text) || '').slice(0, 300);
    const lang = pickLang(text, req.lang);
    const uid = String(userId);
    try {
      if (!text.trim()) return { type: 'unknown', say: say('unknown', lang), lang };
      const ctx = getCtx(uid);
      let rec = recognise(text, { lang });

      // 1) answering a question we asked ("Who?" -> "Wanjiru")
      if (ctx && ctx.pending && (!rec.matched || rec.intent === ctx.pending.intent || rec.missing && rec.missing.length || (ctx.pending.missing[0] === 'when' && nlp.parseWhen(text)))) {   // a time given while we wait for a time answers that question ("tomorrow" must not start a forecast)
        const p = ctx.pending, prep = nlp.prepare(text), slots = Object.assign({}, p.slots);
        const field = p.missing[0];
        const filled = (() => {
          if (field === 'amount') return nlp.extractAmount(prep);
          if (field === 'when') { const w = nlp.parseWhen(text); if (w) { slots.whenAt = w.dueAt; return w.date; } return nlp.extractDueDate(prep); }
          if (field === 'task') return text.trim().replace(/[?.!,]+$/, '').slice(0, 140) || null;
          if (field === 'to') return nlp.extractPhone(prep) || (text.trim().split(/\s+/).slice(0, 3).join(' ') || null);
          return text.trim().replace(/[?.!,]+$/, '').split(/\s+/).slice(0, field === 'items_text' ? 24 : 3).join(' ') || null;
        })();
        if (filled != null && filled !== '') {
          slots[field] = field === 'items_text' ? text.slice(0, 160) : filled;
          const missing = p.missing.slice(1).filter((k) => slots[k] == null);
          rec = Object.assign({}, p.rec, { slots, missing, matched: true, ambiguous: false });
          clear(uid);
        }
      } else if (ctx && ctx.lastIntent && ctx.lastTool && (!rec.matched || rec.confidence < 0.7)) {
        // 2) follow-up with only a new period: "and last week?" / "na wiki iliyopita?"
        const period = nlp.extractPeriod(nlp.prepare(text));
        if (period) rec = { matched: true, intent: ctx.lastIntent, confidence: 0.7, tool: ctx.lastTool, ui: null, slots: Object.assign({}, ctx.lastSlots, { period }), missing: [], ambiguous: false, followUp: true };
      }

      // 3) nothing matched: optional local model, validated through the same registry; otherwise honest "I don't know"
      if (!rec.matched) {
        if (llm) {
          try {
            const g = await llm({ text, catalogue: voiceActions.catalogue() });
            const built = g && g.action && Number(g.confidence) >= 0.7 ? voiceActions.buildPhrase(g.action, g.slots) : null;
            if (built) return { type: 'action', intent: built.id, confidence: Number(g.confidence), phrase: built.phrase, module: built.module, source: 'local-llm', lang };
          } catch (_) { /* model unavailable: fall through to rules-only answer */ }
        }
        return { type: 'unknown', say: say('unknown', lang), lang, source: 'rules' };
      }

      // 4) ambiguity: ask, do not guess
      if (rec.ambiguous && !rec.followUp && rec.candidates && rec.candidates.length > 1) {
        return { type: 'clarify', reason: 'ambiguous', options: rec.candidates.slice(0, 2).map((c) => c.intent),
          say: lang === 'sw' ? `Je, unamaanisha ${rec.candidates[0].intent} au ${rec.candidates[1].intent}?` : `Did you mean ${rec.candidates[0].intent} or ${rec.candidates[1].intent}?`, lang };
      }

      // 5) missing detail: ask for exactly one thing and remember the rest
      if (rec.missing && rec.missing.length) {
        setCtx(uid, { pending: { intent: rec.intent, slots: rec.slots, missing: rec.missing, rec } });
        return { type: 'clarify', reason: 'missing', missing: rec.missing[0], say: say(MISSING_Q[rec.missing[0]] || 'ask_name', lang), lang };
      }

      // 6) reminders: saved for the caller only when a reminders store is configured (and only reported saved once the row exists);
      //    without a store we fall back to "prepared" so the client confirms and schedules it itself.
      if (rec.intent === 'reminder.create') {
        setCtx(uid, { lastIntent: rec.intent, lastSlots: rec.slots, lastTool: null, pending: null });
        if (reminders && rec.slots.whenAt) {
          const task = rec.slots.task || null;
          if (!task) { setCtx(uid, { pending: { intent: rec.intent, slots: rec.slots, missing: ['task'], rec } }); return { type: 'clarify', reason: 'missing', missing: 'task', say: say('ask_task', lang), lang }; }
          let r; try { r = await reminders.create(userId, { text: task, dueAt: rec.slots.whenAt, source: 'voice' }); } catch (_) { r = { ok: false, error: 'store_failed' }; }
          if (r && r.ok) {
            const when = require('./reminders').fmtWhen(r.reminder.dueAt, lang);
            return { type: 'answer', intent: rec.intent, source: 'saved', say: lang === 'sw' ? `Sawa, nitakukumbusha "${task}" ${when}.` : `Done. I will remind you "${task}" on ${when} (Nairobi time).`, reminder: r.reminder, undo: { method: 'DELETE', path: '/api/intelligence/reminders/' + r.reminder.id }, lang };
          }
          const why = { time_in_past: 'reminder_past', too_many_reminders: 'reminder_limit' }[r && r.error];
          return { type: 'answer', intent: rec.intent, source: 'none', say: say(why || 'tool_failed', lang), lang };
        }
        return { type: 'prepare', intent: rec.intent, sensitive: true, requiresConfirmation: true, reminder: { when: rec.slots.when, text: rec.slots.task || text.slice(0, 140) }, say: say('confirm_first', lang), lang };
      }

      // 7) read-only server tool
      if (rec.tool && tools) {
        if (rec.slots.unsupportedPeriod) return { type: 'unknown', say: say('cannot_period', lang), lang };
        const args = { userId, shopId: req.shopId, period: rec.slots.period, who: rec.slots.who, amount: rec.slots.amount };
        let r;
        try { r = await tools.run(rec.tool, args); } catch (e) { r = { ok: false, error: 'tool_error' }; }
        if (r && r.ok) {
          setCtx(uid, { lastIntent: rec.intent, lastSlots: rec.slots, lastTool: rec.tool, pending: null });
          return { type: 'answer', intent: rec.intent, confidence: rec.confidence, source: r.kind === 'predicted' ? 'predicted' : 'retrieved', say: lang === 'sw' ? r.say.sw : r.say.en, data: r.data, caveat: r.caveat, lang };
        }
        if (r && r.say) return { type: 'answer', intent: rec.intent, source: 'none', say: lang === 'sw' ? r.say.sw : r.say.en, lang };
        return { type: 'error', error: 'tool_failed', say: say('tool_failed', lang), lang };
      }

      // 8) existing on-screen action (client handler validates + confirms)
      if (rec.ui) {
        const out = uiResult(rec, lang, { lang });
        if (!out) return { type: 'unknown', say: rec.slots.unsupportedPeriod ? say('cannot_period', lang) : say('unknown', lang), lang };
        setCtx(uid, { lastIntent: rec.intent, lastSlots: rec.slots, lastTool: null, pending: null });
        return out;
      }
      return { type: 'unknown', say: say('unknown', lang), lang };
    } catch (e) {
      return { type: 'error', error: 'engine_failed', say: say('tool_failed', lang), lang };
    }
  }

  return { handle, _store: store, clearContext: clear, newRequestId: () => crypto.randomUUID() };
}

module.exports = { createEngine, T };
