// --- utils/constants.js ---
// Shared, cross-cutting constants. This file existed but was empty/unused.
//
// MARKETPLACE_CATEGORIES is the single canonical list of valid `Tool.category`
// values. Before this fix it was independently duplicated (and had drifted
// out of sync) in three places:
//   - src/models/Tool.js               (Sequelize `isIn` validator)
//   - src/controllers/toolsController.js (createListing's validCategories)
//   - src/controllers/marketplace.controller.js (_sanitizeCategory's VALID)
// ...plus a FOURTH, partially-overlapping list in
// marketplace.controller.js's getCategories() (what buyers see in the
// category filter bar) that included 'construction', 'toys', 'food', and
// 'automotive' — none of which were in any of the three save-side
// whitelists, so picking "Building & Construction" (or Toys/Food/
// Automotive) from the displayed list silently saved as 'other' once
// submitted. That mismatch is why this got centralized: every consumer
// below is required from this one array so they can never drift apart
// again.
//
// The list itself is the UNION of every value that appeared in any of the
// four previous lists — nothing that used to validate was removed, so
// existing `tools` rows using any of these values remain valid (preserves
// backward compatibility with existing marketplace data per the "do not
// guess unknown categories" requirement).
const MARKETPLACE_CATEGORIES = [
  // Core / cross-type
  'electronics', 'furniture', 'clothing', 'books', 'services', 'digital',
  'premium', 'other',
  // Service subcategories (Create Listing → Service tab dropdown)
  'tutoring', 'repair', 'design', 'tech', 'cleaning', 'events', 'beauty',
  'transport',
  // Digital-item subcategories (Create Listing → Digital Item tab dropdown)
  'notes', 'templates', 'ebooks', 'software', 'audio', 'courses',
  // Physical Product tab (#physCategory <select> in Tools.html)
  'phones', 'appliances', 'health', 'home', 'fashion', 'computing',
  'gaming', 'baby', 'sports', 'supermarket', 'garden',
  // Were only in marketplace.controller.js's _sanitizeCategory/getCategories
  // lists, not in the save-side whitelist used by Tool.js/toolsController —
  // now valid everywhere.
  'toys', 'food', 'automotive',
  // Was only in getCategories()'s displayed list (buyers could filter by
  // it), never in any save-side whitelist — now valid everywhere.
  'construction',
];

// Metadata (display name/icon/color) for the categories that are shown in
// the buyer-facing category filter bar (GET /api/marketplace/categories).
// Not every value in MARKETPLACE_CATEGORIES needs an entry here — many are
// subcategory-style values (e.g. 'tutoring', 'phones') selected from a
// nested dropdown, not top-level filter chips.
const MARKETPLACE_CATEGORY_DISPLAY = [
  { id: 'electronics',  name: 'Electronics',             icon: '📱', color: '#2196F3' },
  { id: 'fashion',      name: 'Fashion',                 icon: '👗', color: '#E91E63' },
  { id: 'home',         name: 'Home & Garden',           icon: '🏠', color: '#4CAF50' },
  { id: 'furniture',    name: 'Furniture & Home',        icon: '🛋️', color: '#8D6E63' },
  { id: 'construction', name: 'Building & Construction', icon: '🧱', color: '#78909C' },
  { id: 'beauty',       name: 'Beauty',                  icon: '💄', color: '#FF4081' },
  { id: 'sports',       name: 'Sports',                  icon: '⚽', color: '#FF9800' },
  { id: 'books',        name: 'Books',                   icon: '📚', color: '#795548' },
  { id: 'toys',         name: 'Toys',                    icon: '🧸', color: '#FFC107' },
  { id: 'food',         name: 'Food & Groceries',        icon: '🛒', color: '#66BB6A' },
  { id: 'automotive',   name: 'Automotive',              icon: '🚗', color: '#607D8B' },
  { id: 'services',     name: 'Services',                icon: '🔧', color: '#9C27B0' },
  { id: 'digital',      name: 'Digital',                 icon: '💾', color: '#00BCD4' },
  { id: 'health',       name: 'Health',                  icon: '💊', color: '#F44336' },
  { id: 'other',        name: 'Other',                   icon: '📦', color: '#9E9E9E' },
];

module.exports = {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_DISPLAY,
};
