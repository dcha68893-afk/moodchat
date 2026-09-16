// Canonical marketplace category vocabulary shared by Tool, controllers and
// the buyer-facing catalog. Values are stable IDs; display metadata belongs
// to the catalog route so clients can build a hierarchical picker.
const MARKETPLACE_CATEGORIES = [
  'electronics','furniture','clothing','books','services','digital','premium','other',
  'tutoring','repair','design','tech','cleaning','events','beauty','transport',
  'notes','templates','ebooks','software','audio','courses',
  'phones','appliances','health','home','fashion','computing','gaming','baby','sports','supermarket','garden',
  'toys','food','automotive','construction',
  // Home/Gas vertical
  'gas-cylinders','6kg-gas','13kg-gas','35kg-gas','gas-refill'
];

const MARKETPLACE_CATEGORY_DISPLAY = [
  { id:'electronics',name:'Electronics',icon:'📱' },
  { id:'fashion',name:'Fashion',icon:'👗' },
  { id:'home',name:'Home & Garden',icon:'🏠' },
  { id:'furniture',name:'Furniture & Home',icon:'🛋️' },
  { id:'gas-cylinders',name:'Gas Cylinders',icon:'🔥' },
  { id:'construction',name:'Building & Construction',icon:'🧱' },
  { id:'beauty',name:'Beauty',icon:'💄' },
  { id:'sports',name:'Sports',icon:'⚽' },
  { id:'books',name:'Books',icon:'📚' },
  { id:'toys',name:'Toys',icon:'🧸' },
  { id:'food',name:'Food & Groceries',icon:'🛒' },
  { id:'automotive',name:'Automotive',icon:'🚗' },
  { id:'services',name:'Services',icon:'🔧' },
  { id:'digital',name:'Digital',icon:'💾' },
  { id:'health',name:'Health',icon:'💊' },
  { id:'other',name:'Other',icon:'📦' },
];

module.exports={MARKETPLACE_CATEGORIES,MARKETPLACE_CATEGORY_DISPLAY};
