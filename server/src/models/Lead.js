const mongoose = require('mongoose');

const STATUSES = ['new', 'interested', 'callback', 'not_interested', 'not_reachable', 'converted'];

const leadSchema = new mongoose.Schema(
  {
    date: { type: Date, default: Date.now },
    mobile: { type: String, required: true, unique: true, index: true },
    name: { type: String, trim: true, default: '' },
    score: { type: Number, default: null },
    income: { type: Number, default: null },
    location: { type: String, trim: true, default: '' },
    status: { type: String, enum: STATUSES, default: 'new' },
    remarks: { type: String, default: '' },
    followUpDate: { type: Date, default: null },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

leadSchema.index({ location: 1 });
leadSchema.index({ status: 1, followUpDate: 1 });

module.exports = mongoose.model('Lead', leadSchema);
module.exports.STATUSES = STATUSES;
