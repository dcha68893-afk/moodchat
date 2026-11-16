'use strict';
/**
 * NECPRA Voice: registry of ACTIONS the AI is allowed to choose from (phase 1: Friends, Money, DUKA SMART + screen navigation).
 *
 * The AI never executes anything and never invents an action. It only picks an id from this list and fills named slots.
 * The server then turns (id + sanitised slots) into a CANONICAL ENGLISH PHRASE that the existing on-screen voice handlers
 * already understand (necpra-voice-friends.js, necpra-voice-money-nlu.js, DUKA vParse, shell navigation). So every existing
 * safety rule keeps working unchanged: confirmations before sending/declining/removing, no spoken payments, honest errors.
 *
 * To add a feature: add an entry here, then run tools/verify-voice-actions.js (frontend checkout) to prove the phrase parses.
 */
const NAV_PAGES = ['messages', 'money', 'friends', 'tools', 'group', 'status', 'settings', 'games'];
const NAV_WORD = { messages: 'messenger', money: 'wallet', friends: 'friends', tools: 'duka smart', group: 'groups', status: 'status', settings: 'settings', games: 'games' };

const FRIEND_TAB = { friends: 'show my friends list', discover: 'show discover', requests: 'show requests', sent: 'show sent requests', groups: 'show discover groups', nearby: 'show nearby' };
const MONEY_TAB = { wallet: 'open wallet', circles: 'open chama', goals: 'open savings goals', requests: 'open payment requests', paylater: 'open pay later', airtime: 'open airtime', activity: 'open activity' };

const GAME_WORD = { block: 'block puzzle', trivia: 'trivia', crossword: 'crossword', chess: 'chess' };
const SECTIONS = ['profile', 'security', 'privacy', 'notifications', 'appearance', 'storage', 'advanced', 'chat'];
const en = (values) => ({ type: 'enum', values, required: true });
const str = (required = true) => ({ type: 'string', required });
const num = (required = true) => ({ type: 'number', required });

const ACTIONS = [
  // ───── navigation ─────
  { id: 'nav.open', module: 'shell', desc: 'Go to one of the app screens (messenger, wallet/money/chama, friends, DUKA SMART/shop/tools, groups, status, settings, games)',
    slots: { page: en(NAV_PAGES) }, phrase: (s) => 'open ' + NAV_WORD[s.page] },
  { id: 'nav.back', module: 'shell', desc: 'Go back to the previous screen', slots: {}, phrase: () => 'go back' },

  // ───── Friends ─────
  { id: 'friends.open_tab', module: 'friends', desc: 'Show a tab of the Friends screen: my friends, discover people, incoming requests, sent requests, discover groups, nearby people',
    slots: { tab: en(Object.keys(FRIEND_TAB)) }, phrase: (s) => FRIEND_TAB[s.tab] },
  { id: 'friends.check_requests', module: 'friends', desc: 'Are there / do I have any pending incoming friend requests, and who from',
    slots: {}, phrase: () => 'do i have any friend requests' },
  { id: 'friends.count_friends', module: 'friends', desc: 'How many friends the user has', slots: {}, phrase: () => 'how many friends do i have' },
  { id: 'friends.count_requests', module: 'friends', desc: 'How many pending friend requests the user has', slots: {}, phrase: () => 'how many requests do i have' },
  { id: 'friends.read_friends', module: 'friends', desc: 'Read out the names of the user\'s friends', slots: {}, phrase: () => 'read my friends' },
  { id: 'friends.read_requests', module: 'friends', desc: 'Read out the names of people who sent friend requests', slots: {}, phrase: () => 'read my requests' },
  { id: 'friends.accept', module: 'friends', desc: 'Accept the friend request from a named person', slots: { name: str() }, phrase: (s) => 'accept ' + s.name },
  { id: 'friends.decline', module: 'friends', desc: 'Decline / reject the friend request from a named person', slots: { name: str() }, phrase: (s) => 'decline ' + s.name },
  { id: 'friends.cancel', module: 'friends', desc: 'Cancel a friend request the user SENT to a named person', slots: { name: str() }, phrase: (s) => 'cancel my request to ' + s.name },
  { id: 'friends.add', module: 'friends', desc: 'Send a friend request to / add a named person as a friend', slots: { name: str() }, phrase: (s) => 'add ' + s.name + ' as a friend' },
  { id: 'friends.remove', module: 'friends', desc: 'Remove / unfriend a named person from the user\'s friends', slots: { name: str() }, phrase: (s) => 'remove ' + s.name + ' from my friends' },
  { id: 'friends.search', module: 'friends', desc: 'Search for a person by name in Friends', slots: { query: str() }, phrase: (s) => 'search for ' + s.query },
  { id: 'friends.refresh', module: 'friends', desc: 'Refresh the Friends list', slots: {}, phrase: () => 'refresh friends' },

  // ───── Money (wallet, chama, pay later) ─────
  { id: 'money.balance', module: 'money', desc: 'What is the wallet balance / how much money does the user have', slots: {}, phrase: () => 'what is my balance' },
  { id: 'money.transactions', module: 'money', desc: 'Show / read the latest wallet transactions', slots: {}, phrase: () => 'show my latest transactions' },
  { id: 'money.received', module: 'money', desc: 'How much money the user received', slots: {}, phrase: () => 'how much have i received' },
  { id: 'money.spent', module: 'money', desc: 'How much money the user spent, today or this month', slots: { period: en(['today', 'month']) }, phrase: (s) => 'how much did i spend ' + (s.period === 'month' ? 'this month' : 'today') },
  { id: 'money.orders', module: 'money', desc: 'Show the user\'s pending / unpaid Pay Later orders', slots: {}, phrase: () => 'show my pending orders' },
  { id: 'money.chama_month', module: 'money', desc: 'What chama contributions are due this month', slots: {}, phrase: () => 'chama contributions this month' },
  { id: 'money.chama_outstanding', module: 'money', desc: 'Who still owes / has not paid their chama contribution', slots: {}, phrase: () => 'outstanding chama contributions' },
  { id: 'money.open_tab', module: 'money', desc: 'Open a Money tab: wallet, chama (circles), savings goals, payment requests, pay later, airtime/data bundles, activity',
    slots: { tab: en(Object.keys(MONEY_TAB)) }, phrase: (s) => MONEY_TAB[s.tab] },
  { id: 'money.prepare_transfer', module: 'money', desc: 'Prepare (NOT make) a payment of an amount to a person or phone number; the app only opens a pre-filled Send screen that the user must confirm',
    slots: { amount: num(), to: str() }, phrase: (s) => 'send ' + s.amount + ' to ' + s.to },

  // ───── Messenger ─────
  { id: 'messages.unread_check', module: 'messages', desc: 'Are there / how many new unread messages', slots: {}, phrase: () => 'do i have any unread messages' },
  { id: 'messages.read_new', module: 'messages', desc: 'Read out the user\'s new / latest messages', slots: {}, phrase: () => 'read my new messages' },
  { id: 'messages.read_from', module: 'messages', desc: 'Read the messages from a named person', slots: { name: str() }, phrase: (s) => 'read my messages from ' + s.name },
  { id: 'messages.open_chat', module: 'messages', desc: 'Open the chat with a named person', slots: { name: str() }, phrase: (s) => 'open chat with ' + s.name },
  { id: 'messages.search_chat', module: 'messages', desc: 'Search for a chat with a named person', slots: { name: str() }, phrase: (s) => 'search chat with ' + s.name },
  // Chat-list actions on ONE named chat. The Messenger screen asks the user to confirm archive / delete / block before doing anything.
  { id: 'messages.archive_chat', module: 'messages', desc: 'Archive the chat with a named person (the app asks the user to confirm)', slots: { name: str() }, phrase: (s) => 'archive chat with ' + s.name },
  { id: 'messages.mute_chat', module: 'messages', desc: 'Mute the notifications of the chat with a named person', slots: { name: str() }, phrase: (s) => 'mute chat with ' + s.name },
  { id: 'messages.unmute_chat', module: 'messages', desc: 'Unmute the chat with a named person', slots: { name: str() }, phrase: (s) => 'unmute chat with ' + s.name },
  { id: 'messages.favourite_chat', module: 'messages', desc: 'Add the chat with a named person to favourites', slots: { name: str() }, phrase: (s) => 'add ' + s.name + ' to favourites' },
  { id: 'messages.unfavourite_chat', module: 'messages', desc: 'Remove the chat with a named person from favourites', slots: { name: str() }, phrase: (s) => 'remove ' + s.name + ' from favourites' },
  { id: 'messages.mark_unread', module: 'messages', desc: 'Mark the chat with a named person as unread', slots: { name: str() }, phrase: (s) => 'mark chat with ' + s.name + ' as unread' },
  { id: 'messages.delete_chat', module: 'messages', desc: 'Delete the chat with a named person from the user\'s own account (the app asks the user to confirm)', slots: { name: str() }, phrase: (s) => 'delete chat with ' + s.name },
  { id: 'messages.block_user', module: 'messages', desc: 'Block a named person from messaging the user (the app asks the user to confirm)', slots: { name: str() }, phrase: (s) => 'block ' + s.name },
  // ───── Groups ─────
  { id: 'groups.open', module: 'group', desc: 'Open a named group chat', slots: { name: str() }, phrase: (s) => 'open group ' + s.name },
  { id: 'groups.create', module: 'group', desc: 'Create a new group with a name', slots: { name: str() }, phrase: (s) => 'create group ' + s.name },
  { id: 'groups.read', module: 'group', desc: 'Read the latest messages of the open group', slots: {}, phrase: () => 'read the latest group messages' },
  { id: 'groups.members', module: 'group', desc: 'Show / list the members of the open group', slots: {}, phrase: () => 'show members' },
  { id: 'groups.member_count', module: 'group', desc: 'How many members the open group has', slots: {}, phrase: () => 'how many members' },
  { id: 'groups.count', module: 'group', desc: 'How many groups the user is in', slots: {}, phrase: () => 'how many groups do i have' },
  { id: 'groups.refresh', module: 'group', desc: 'Refresh the groups list', slots: {}, phrase: () => 'refresh groups' },
  { id: 'groups.close', module: 'group', desc: 'Close the open group', slots: {}, phrase: () => 'close this group' },
  { id: 'groups.info', module: 'group', desc: 'Show the info / details of the open group', slots: {}, phrase: () => 'show group info' },
  { id: 'groups.pinned', module: 'group', desc: 'Show the pinned messages of the open group', slots: {}, phrase: () => 'show pinned messages' },
  { id: 'groups.media', module: 'group', desc: 'Show the files and media shared in the open group', slots: {}, phrase: () => 'show group media' },
  { id: 'groups.add_member', module: 'group', desc: 'Add one of the user\'s friends to a group (the open one if no group is named). The app asks the user to confirm', slots: { name: str(), group: str(false) }, phrase: (s) => 'add ' + s.name + ' to ' + (s.group ? 'the ' + s.group + ' group' : 'this group') },
  { id: 'groups.leave', module: 'group', desc: 'Leave a group the user is in (the open one if no group is named). The app asks the user to confirm', slots: { group: str(false) }, phrase: (s) => s.group ? 'leave the ' + s.group + ' group' : 'leave this group' },
  // ───── Status ─────
  { id: 'status.view', module: 'status', desc: 'Watch the status / story of a named person', slots: { name: str() }, phrase: (s) => 'show ' + s.name + ' status' },
  { id: 'status.who', module: 'status', desc: 'Who has posted a status', slots: {}, phrase: () => 'who posted a status' },
  { id: 'status.count', module: 'status', desc: 'Are there any new statuses / how many', slots: {}, phrase: () => 'are there any new statuses' },
  { id: 'status.post_open', module: 'status', desc: 'Start creating a new status (opens the composer; nothing is posted)', slots: {}, phrase: () => 'create a status' },
  { id: 'status.next', module: 'status', desc: 'Go to the next status', slots: {}, phrase: () => 'next status' },
  { id: 'status.prev', module: 'status', desc: 'Go to the previous status', slots: {}, phrase: () => 'previous status' },
  { id: 'status.close', module: 'status', desc: 'Close the status viewer', slots: {}, phrase: () => 'close status' },
  { id: 'status.vibes', module: 'status', desc: 'Open Vibes (video feed)', slots: {}, phrase: () => 'open vibes' },
  { id: 'status.love', module: 'status', desc: 'Love / react with a heart to the current status', slots: {}, phrase: () => 'love this status' },
  { id: 'status.mine', module: 'status', desc: 'Open the user\'s own status', slots: {}, phrase: () => 'show my status' },
  { id: 'status.viewers', module: 'status', desc: 'Who has viewed the user\'s own status / how many views it has', slots: {}, phrase: () => 'who viewed my status' },
  // ───── Settings (security, passwords, PIN, backup, sessions and account deletion are never changed by voice) ─────
  { id: 'settings.open_section', module: 'settings', desc: 'Open a Settings section', slots: { section: en(SECTIONS) }, phrase: (s) => 'open ' + s.section + ' settings' },
  { id: 'settings.theme', module: 'settings', desc: 'Switch the app between dark mode and light mode', slots: { theme: en(['dark', 'light']) }, phrase: (s) => s.theme === 'dark' ? 'turn on dark mode' : 'turn off dark mode' },
  { id: 'settings.toggle', module: 'settings', desc: 'Turn a named on/off setting (e.g. read receipts, notifications, sounds) on or off', slots: { state: en(['on', 'off']), name: str() }, phrase: (s) => 'turn ' + s.state + ' ' + s.name },
  // ───── Games ─────
  { id: 'games.play', module: 'games', desc: 'Start a game: block puzzle, trivia, crossword or chess', slots: { game: en(Object.keys(GAME_WORD)) }, phrase: (s) => 'play ' + GAME_WORD[s.game] },
  { id: 'games.home', module: 'games', desc: 'Go back to the game list', slots: {}, phrase: () => 'go to the arcade' },
  { id: 'games.coins', module: 'games', desc: 'How many game coins the user has', slots: {}, phrase: () => 'how many coins do i have' },
  { id: 'games.best', module: 'games', desc: 'The user\'s best game score', slots: {}, phrase: () => 'my best score' },
  { id: 'games.list', module: 'games', desc: 'Which games can be played', slots: {}, phrase: () => 'which games can i play' },
  { id: 'games.sound', module: 'games', desc: 'Mute or unmute the game sound', slots: { state: en(['on', 'off']) }, phrase: (s) => s.state === 'off' ? 'mute' : 'unmute' },
  { id: 'games.question', module: 'games', desc: 'Read the current quiz question again', slots: {}, phrase: () => 'read the question' },

  // ───── DUKA SMART (shop / point of sale) ─────
  { id: 'duka.sale', module: 'tools', desc: 'Record a sale the shopkeeper made. items_text = what was sold with quantities in plain words (e.g. "2 bags of sugar and 1 bread"). payment optional',
    slots: { items_text: str(), payment: { type: 'enum', values: ['cash', 'mpesa', 'credit'], required: false } },
    phrase: (s) => 'i sold ' + s.items_text + (s.payment === 'mpesa' ? ' by mpesa' : s.payment === 'credit' ? ' on credit' : s.payment === 'cash' ? ' for cash' : '') },
  { id: 'duka.stock', module: 'tools', desc: 'How much stock is left of a named product', slots: { product: str() }, phrase: (s) => 'how much ' + s.product + ' do we have in stock' },
  { id: 'duka.products_count', module: 'tools', desc: 'How many products the shop has', slots: {}, phrase: () => 'how many products do we have' },
  { id: 'duka.low_stock', module: 'tools', desc: 'Which products are running low or finished', slots: {}, phrase: () => 'which products are running low on stock' },
  { id: 'duka.customers_count', module: 'tools', desc: 'How many customers the shop has', slots: {}, phrase: () => 'how many customers do we have' },
  { id: 'duka.report', module: 'tools', desc: 'Sales / takings report for today, this week or this month', slots: { period: en(['today', 'week', 'month']) },
    phrase: (s) => 'how much did we sell ' + (s.period === 'week' ? 'this week' : s.period === 'month' ? 'this month' : 'today') },
  { id: 'duka.debts', module: 'tools', desc: 'Who owes the shop money (credit customers), optionally one named customer', slots: { who: str(false) },
    phrase: (s) => s.who ? 'how much does ' + s.who + ' owe me' : 'who owes me' },
  { id: 'duka.expense', module: 'tools', desc: 'Record a shop expense of an amount, with what it was for', slots: { amount: num(), description: str(false) },
    phrase: (s) => 'i spent ' + s.amount + (s.description ? ' on ' + s.description : '') },
  { id: 'duka.add_product', module: 'tools', desc: 'Add a new product to the shop with optional buying price, selling price and opening stock',
    slots: { name: str(), buy: num(false), sell: num(false), stock: num(false) },
    phrase: (s) => 'add new product ' + s.name + (s.buy != null ? ' buying price ' + s.buy : '') + (s.sell != null ? ' selling price ' + s.sell : '') + (s.stock != null ? ' stock ' + s.stock : '') }
];

const BY_ID = Object.fromEntries(ACTIONS.map((a) => [a.id, a]));

/* Slot hygiene: the AI output is untrusted text. Only letters/digits/space and a few name characters survive, length is capped,
 * numbers must be finite and sensible, enums must match exactly. Anything else rejects the whole action (-> falls back to "not understood"). */
function cleanText(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.normalize('NFKC').replace(/[^\p{L}\p{N} '’.@+\-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return t || null;
}
function cleanNumber(v) {
  const n = typeof v === 'string' ? Number(v.replace(/[, ]/g, '')) : v;
  return Number.isFinite(n) && n > 0 && n <= 10000000 ? Math.round(n * 100) / 100 : null;
}

function validate(actionId, rawSlots) {
  const a = BY_ID[actionId];
  if (!a) return null;
  const raw = rawSlots && typeof rawSlots === 'object' ? rawSlots : {};
  const slots = {};
  for (const [name, def] of Object.entries(a.slots)) {
    let v = raw[name];
    if (v === undefined || v === null || v === '') { if (def.required) return null; continue; }
    if (def.type === 'enum') { if (!def.values.includes(v)) return null; }
    else if (def.type === 'number') { v = cleanNumber(v); if (v == null) return null; }
    else { v = cleanText(v, name === 'items_text' ? 160 : 48); if (v == null) { if (def.required) return null; continue; } }
    slots[name] = v;
  }
  return { action: a, slots };
}

function buildPhrase(actionId, rawSlots) {
  const ok = validate(actionId, rawSlots);
  if (!ok) return null;
  return { id: ok.action.id, module: ok.action.module, slots: ok.slots, phrase: ok.action.phrase(ok.slots) };
}

// Compact catalogue for the AI prompt
function catalogue() {
  return ACTIONS.map((a) => {
    const sl = Object.entries(a.slots).map(([k, d]) => k + (d.required ? '' : '?') + (d.type === 'enum' ? '=' + d.values.join('|') : ':' + d.type)).join(', ');
    return a.id + (sl ? ' (' + sl + ')' : '') + ' - ' + a.desc;
  }).join('\n');
}

// For the admin screen: what an admin may map a phrase to
function describe() { return ACTIONS.map((a) => ({ id: a.id, module: a.module, desc: a.desc, slots: Object.fromEntries(Object.entries(a.slots).map(([k, d]) => [k, { type: d.type, required: !!d.required, values: d.values || undefined }])) })); }

module.exports = { ACTIONS, BY_ID, NAV_PAGES, validate, buildPhrase, catalogue, describe, cleanText, cleanNumber };
