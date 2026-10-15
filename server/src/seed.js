// Creates the first admin. Run once:  npm run seed
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/finance_crm');
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';

  if (await User.findOne({ username })) {
    console.log(`User "${username}" already exists. Nothing to do.`);
  } else {
    await User.create({ name: 'Administrator', username, password, role: 'admin' });
    console.log(`Admin created. Login: ${username} / ${password}  (change this password after first login)`);
  }
  await mongoose.disconnect();
})();
