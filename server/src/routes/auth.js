const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect, allow } = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }

  const user = await User.findOne({ username: String(username).toLowerCase() }).select('+password');
  if (!user || !user.active || !(await user.matchPassword(password))) {
    return res.status(401).json({ message: 'Wrong username or password' });
  }

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  });

  res.json({
    token,
    user: { id: user._id, name: user.name, username: user.username, role: user.role },
  });
});

router.get('/me', protect, (req, res) => {
  const u = req.user;
  res.json({ id: u._id, name: u.name, username: u.username, role: u.role });
});

router.post('/change-password', protect, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ message: 'New password must be at least 6 characters' });
  }
  const user = await User.findById(req.user._id).select('+password');
  if (!(await user.matchPassword(oldPassword || ''))) {
    return res.status(400).json({ message: 'Current password is wrong' });
  }
  user.password = newPassword;
  await user.save();
  res.json({ ok: true });
});

// Admin: list and create users (callers, managers)
router.get('/users', protect, allow('admin', 'manager'), async (req, res) => {
  const users = await User.find().sort({ name: 1 });
  res.json(users);
});

router.post('/users', protect, allow('admin'), async (req, res) => {
  try {
    const { name, username, password, role } = req.body;
    const user = await User.create({ name, username, password, role });
    res.status(201).json({ id: user._id, name: user.name, username: user.username, role: user.role });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Username already exists' });
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;
