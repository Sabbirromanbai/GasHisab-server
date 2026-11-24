import mongoose from 'mongoose';
import Business from '../../src/modules/business.model.js';
import BusinessMember from '../../src/modules/business-member.model.js';
import Product from '../../src/modules/product.model.js';
import Stock from '../../src/modules/stock.model.js';
import Supplier from '../../src/modules/supplier.model.js';
import User from '../../src/modules/user.model.js';
import RefillBatch from '../../src/modules/refill-batch.model.js';
import RefillIssueResolution from '../../src/modules/refill-issue-resolution.model.js';
import RefillRate from '../../src/modules/refill-rate.model.js';
import RefillReceipt from '../../src/modules/refill-receipt.model.js';
import RefillReplacementReceipt from '../../src/modules/refill-replacement-receipt.model.js';
import StockMovement from '../../src/modules/stock-movement.model.js';
import SupplierPayment from '../../src/modules/supplier-payment.model.js';

const unique = (label) => `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const createRefillFixture = async () => {
  const fixture = {};
  try {
    fixture.business = await Business.create({ name: unique('Dealer'), slug: unique('dealer').toLowerCase() });
    fixture.otherBusiness = await Business.create({ name: unique('Other'), slug: unique('other').toLowerCase() });
    fixture.user = await User.create({ name: 'Test Operator', email: `${unique('operator')}@example.test`, passwordHash: 'test-only' });
    fixture.otherUser = await User.create({ name: 'Other Operator', email: `${unique('other')}@example.test`, passwordHash: 'test-only' });
    await BusinessMember.create([
      { businessId: fixture.business._id, userId: fixture.user._id, role: 'owner' },
      { businessId: fixture.otherBusiness._id, userId: fixture.otherUser._id, role: 'owner' },
    ]);

    fixture.supplier = await Supplier.create({
      businessId: fixture.business._id,
      name: unique('Plant'),
      brandAuthorizations: [{ brand: 'brand-a' }, { brand: 'brand-b' }],
    });
    fixture.unauthorizedSupplier = await Supplier.create({
      businessId: fixture.business._id,
      name: unique('Unauthorized-Plant'),
      brandAuthorizations: [{ brand: 'brand-b' }],
    });

    fixture.products = await Product.create([
      { businessId: fixture.business._id, brand: 'brand-a', cylinderSizeKg: 12, purchasePrice: 1000, sellingPrice: 1400 },
      { businessId: fixture.business._id, brand: 'brand-a', cylinderSizeKg: 35, purchasePrice: 2000, sellingPrice: 2800 },
      { businessId: fixture.business._id, brand: 'brand-b', cylinderSizeKg: 12, purchasePrice: 1100, sellingPrice: 1500 },
    ]);
    await Stock.create(fixture.products.map((product, index) => ({
      businessId: fixture.business._id,
      productId: product._id,
      emptyQty: index === 0 ? 10 : index === 1 ? 6 : 2,
    })));

    return fixture;
  } catch (error) {
    await cleanupRefillFixture(fixture);
    throw error;
  }
};

export const cleanupRefillFixture = async (fixture) => {
  const businessIds = [fixture.business, fixture.otherBusiness].filter(Boolean).map((business) => business._id);
  const userIds = [fixture.user, fixture.otherUser].filter(Boolean).map((user) => user._id);

  // Direct collection cleanup bypasses append-only ledger hooks, but is scoped to this fixture's IDs.
  const businessScopedModels = [
    BusinessMember,
    Product,
    Stock,
    Supplier,
    RefillRate,
    RefillBatch,
    RefillReceipt,
    RefillIssueResolution,
    RefillReplacementReceipt,
    SupplierPayment,
    StockMovement,
  ];
  if (businessIds.length > 0) {
    await Promise.all(businessScopedModels.map((model) => model.collection.deleteMany({ businessId: { $in: businessIds } })));
    await Business.collection.deleteMany({ _id: { $in: businessIds } });
  }
  if (userIds.length > 0) await User.collection.deleteMany({ _id: { $in: userIds } });
};
