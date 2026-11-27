import mongoose from 'mongoose';

const isPoisha = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositiveInt = (value) => Number.isSafeInteger(value) && value >= 1;

/**
 * Embedded purchase line. Only NEW filled cylinder packages in this step
 * (`kind==='lpg_cylinder'`). Dealer-defined money; platform never sets prices.
 * Integer poisha. `_id` is the `sourceLineId` for append-only stock movements.
 */
const purchaseItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, immutable: true },
    kind: { type: String, enum: ['lpg_cylinder'], default: 'lpg_cylinder', required: true }, // new-cylinder purchase only
    quantity: { type: Number, required: true, min: 1, validate: { validator: isPositiveInt, message: 'Quantity must be a positive whole number.' } },
    unitCostPoisha: { type: Number, required: true, min: 0, validate: { validator: isPoisha, message: 'unitCostPoisha must be a non-negative whole number of poisha.' } }, // dealer-defined purchase cost
    sellingPricePoisha: { type: Number, required: true, min: 0, validate: { validator: isPoisha, message: 'sellingPricePoisha must be a non-negative whole number of poisha.' } }, // dealer-defined; platform never sets
    lineTotalPoisha: { type: Number, required: true, min: 0, validate: { validator: isPoisha, message: 'lineTotalPoisha must be a non-negative whole number of poisha.' } }, // quantity * unitCostPoisha
  },
  { _id: true },
);

/**
 * Purchase foundation (new-cylinder supplier purchase). NOT Supplier Returns,
 * NOT Sales. Supplier payments live in append-only SupplierPayment
 * (sourceType='purchase'); `paymentStatus`/`amountPaidPoisha`/`amountDuePoisha`
 * are derived caches recomputed from that append-only history. No destructive
 * change; additive. `businessId`+`supplierId` immutable tenant + supplier.
 */
const purchaseSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, immutable: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, immutable: true }, // must match businessId; re-validated
    purchaseNumber: { type: String, trim: true, maxlength: 64 },
    purchasedAt: { type: Date, default: Date.now },
    items: { type: [purchaseItemSchema], required: true, validate: { validator: (v) => Array.isArray(v) && v.length >= 1, message: 'A purchase needs at least one item.' } },
    totalAmountPoisha: { type: Number, required: true, min: 0, validate: { validator: isPoisha, message: 'totalAmountPoisha must be a non-negative whole number of poisha.' } }, // total cost (sum lineTotalPoisha)
    totalSellingPoisha: { type: Number, required: true, min: 0, validate: { validator: isPoisha } }, // sum quantity*sellingPricePoisha (informational; not a sale)
    // Payment status derived from append-only SupplierPayment history.
    paymentStatus: { type: String, enum: ['unpaid', 'partially_paid', 'paid'], default: 'unpaid', required: true },
    amountPaidPoisha: { type: Number, required: true, default: 0, min: 0, validate: { validator: isPoisha } },
    amountDuePoisha: { type: Number, required: true, min: 0, validate: { validator: isPoisha } },
    status: { type: String, enum: ['draft', 'posted'], default: 'posted', required: true },
    note: { type: String, trim: true, maxlength: 1000 },
    reference: { type: String, trim: true, maxlength: 120 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Posting idempotency. `requestHash` hidden. Unique per business. Append-once.
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 120, immutable: true },
    requestHash: { type: String, required: true, immutable: true, select: false },
  },
  { timestamps: true },
);

purchaseSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true });
purchaseSchema.index({ businessId: 1, supplierId: 1, purchasedAt: -1 });
purchaseSchema.index({ businessId: 1, paymentStatus: 1 });
purchaseSchema.index({ businessId: 1, status: 1 });

const Purchase = mongoose.models.Purchase || mongoose.model('Purchase', purchaseSchema);

export default Purchase;
