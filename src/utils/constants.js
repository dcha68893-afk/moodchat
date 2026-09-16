// --- utils/constants.js ---
// Shared marketplace taxonomy. Every marketplace writer/reader imports this
// file so category validation and discovery cannot drift apart.
const MARKETPLACE_CATEGORIES = [
  'electronics', 'furniture', 'clothing', 'books', 'services', 'digital',
  'premium', 'other',
  'tutoring', 'repair', 'design', 'tech', 'cleaning', 'events', 'beauty',
  'transport',
  'notes', 'templates', 'ebooks', 'software', 'audio', 'courses',
  'phones', 'appliances', 'health', 'home', 'fashion', 'computing',
  'gaming', 'baby', 'sports', 'supermarket', 'garden',
  'toys', 'food', 'automotive', 'construction',
  // Dedicated physical-product family. Listings can additionally store
  // cylinder size/brand/condition in metadata without creating a second
  // marketplace pipeline.
  'gas_cylinders',
];

const MARKETPLACE_CATEGORY_DISPLAY = [
  { id: 'electronics', name: 'Electronics', icon: '📱', color: '#2196F3' },
  { id: 'fashion', name: 'Fashion', icon: '👗', color: '#E91E63' },
  { id: 'home', name: 'Home & Garden', icon: '🏠', color: '#4CAF50' },
  { id: 'furniture', name: 'Furniture & Home', icon: '🛋️', color: '#8D6E63' },
  { id: 'construction', name: 'Building & Construction', icon: '🧱', color: '#78909C' },
  { id: 'beauty', name: 'Beauty', icon: '💄', color: '#FF4081' },
  { id: 'sports', name: 'Sports', icon: '⚽', color: '#FF9800' },
  { id: 'books', name: 'Books', icon: '📚', color: '#795548' },
  { id: 'toys', name: 'Toys', icon: '🧸', color: '#FFC107' },
  { id: 'food', name: 'Food & Groceries', icon: '🛒', color: '#66BB6A' },
  { id: 'automotive', name: 'Automotive', icon: '🚗', color: '#607D8B' },
  { id: 'services', name: 'Services', icon: '🔧', color: '#9C27B0' },
  { id: 'digital', name: 'Digital', icon: '💾', color: '#00BCD4' },
  { id: 'health', name: 'Health', icon: '💊', color: '#F44336' },
  { id: 'gas_cylinders', name: 'Gas Cylinders', icon: '🔥', color: '#FF7043' },
  { id: 'other', name: 'Other', icon: '📦', color: '#9E9E9E' },
];

module.exports = { MARKETPLACE_CATEGORIES, MARKETPLACE_CATEGORY_DISPLAY };