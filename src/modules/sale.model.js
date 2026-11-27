import mongoose from 'mongoose';

const isPoisha = (value) => Number.isSafeInteger(value) && value >= 0;

const saleItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    kind: { type: String, enum: ['lpg_cylinder'], default: 'lpg_cylinder', required: true }, // new-cylinder sales only
    // These values are copied from the product so old invoices do not change with the catalog.
    brand: { type: String, required: true, trim: true, maxlength: 80 },
    cylinderSizeKg: {
      type: Number,
      required: true,
      min: 0.01,
      max: 1000,
      validate: {
        validator: Number.isFinite,
        message: 'Cylinder size must be a finite number.',
      },
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Item quantity must be a positive whole number.',
      },
    },
    // All sale money fields are integer poisha to avoid floating-point rounding.
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: isPoisha,
        message: 'Unit price must be a safe integer amount in poisha.',
      },
    },
    lineTotal: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator(value) {
          const calculatedTotal = this.quantity * this.unitPrice;
          return isPoisha(value) && isPoisha(calculatedTotal) && value === calculatedTotal;
        },
        message: 'Line total must equal quantity multiplied by unit price in poisha.',
      },
    },
  },
  { _id: true }, // line id => `sourceLineId` for append-only stock movements; additive
);

const saleSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      immutable: true, // a sale can never move tenant
    },
    // Customer is OPTIONAL. When present, must be owned by `businessId` (re-validated); cross-tenant => not found.
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
    },
    // Manual invoice number; unique per business. Not auto-generated.
    invoiceNumber: { type: String, required: true, trim: true, maxlength: 64 },
    // Sale date (dealer-entered); `createdAt` remains available. Additive.
    saleDate: { type: Date, default: Date.now },
    items: {
      type: [saleItemSchema],
      required: true,
      validate: {
        validator: (items) => Array.isArray(items) && items.length > 0,
        message: 'A sale must contain at least one item.',
      },
    },
    subtotal: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator(value) {
          const itemTotal = this.items?.reduce((sum, item) => sum + item.lineTotal, 0);
          return isPoisha(value) && isPoisha(itemTotal) && value === itemTotal;
        },
        message: 'Subtotal must equal the sum of item line totals in poisha.',
      },
    },
    discount: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator(value) {
          return isPoisha(value) && value <= this.subtotal;
        },
        message: 'Discount must be a non-negative poisha amount no greater than subtotal.',
      },
    },
    total: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator(value) {
          return isPoisha(value) && value === this.subtotal - this.discount;
        },
        message: 'Total must equal subtotal minus discount in poisha.',
      },
    },
    paidAmount: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator(value) {
          return isPoisha(value) && value <= this.total;
        },
        message: 'Paid amount must be a non-negative poisha amount no greater than total.',
      },
    },
    dueAmount: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator(value) {
          return isPoisha(value) && value === this.total - this.paidAmount;
        },
        message: 'Due amount must equal total minus paid amount in poisha.',
      },
    },
    status: {
      type: String,
      enum: ['unpaid', 'partially_paid', 'paid', 'cancelled'],
      default: 'unpaid',
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Posting idempotency. `requestHash` hidden. Unique per business. Append-once.
    idempotencyKey: { type: String, trim: true, maxlength: 120, immutable: true },
    requestHash: { type: String, immutable: true, select: false },
  },
  { timestamps: true },
);

// Invoice numbers are unique only inside their business tenant.
saleSchema.index({ businessId: 1, invoiceNumber: 1 }, { unique: true });
saleSchema.index({ businessId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $exists: true, $type: 'string' } } });
saleSchema.index({ businessId: 1, customerId: 1, createdAt: -1 });
saleSchema.index({ businessId: 1, status: 1, createdAt: -1 });

const Sale = mongoose.models.Sale || mongoose.model('Sale', saleSchema);

export default Sale;
