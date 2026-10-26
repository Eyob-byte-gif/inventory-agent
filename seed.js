require('dotenv').config();
const mongoose = require('mongoose');

const items = [
  { code: 'BP-001', name: 'Blue Ballpoint Pen', unit: 'pcs', stock: 120 },
  { code: 'BP-002', name: 'Blue Gel Pen', unit: 'pcs', stock: 80 },
  { code: 'NB-010', name: 'A5 Notebook', unit: 'pcs', stock: 45 },
  { code: 'PP-020', name: 'A4 Copy Paper', unit: 'ream', stock: 30 },
  { code: 'ST-030', name: 'Heavy Duty Stapler', unit: 'pcs', stock: 12 },
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const c = mongoose.connection.collection('products');
  await c.deleteMany({});
  await c.insertMany(items);
  console.log('Seeded', items.length, 'products');
  process.exit(0);
})();
