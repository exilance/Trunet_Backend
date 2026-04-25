const express = require('express');
const router = express.Router();

// ============================================
// MIDDLEWARE IMPORTS
// ============================================
const { protect } = require('../middlewares/auth');
const { apiKeyAuth } = require('../middlewares/apiKeyAuth');

// ============================================
// CONTROLLER IMPORTS
// ============================================
// Sales Report Controllers
const {
  generateBranchSalesReport,
  generateQuotationReport,
  generateFieldBasedOutstandingReport,
  generateGCReport,
  generateBookingReport,
  generateInsurancePendingReport,
  generateReceiptReport,
  generateDummyInvoiceReport,
  generateSubdealerSalesReport,
  generateStockTransferReport,
  generateBrokerReport,
  generateVerifiedOutstandingReport,
  generatePendingVerificationOutstandingReport,
  generateSubdealerPaymentAllocationReport,
  getBookingAllocationReport,
  getApprovedReceipts,
} = require('../controllers/salesReportController');

const {
  getInventoryKPIs,
  getCrossSellKPIs,
  getSalesManagementKPIs,
  getSalesDashboardSummary,
  generateCurrentStockReport1
} = require('../controllers/salesdashboardcontroller');
// Other Controllers
const instituteApiController = require('../controllers/instituteApiController');
const bookingController = require('../controllers/bookingController');
const branchController = require('../controllers/branchController');

// ============================================
// SECTION 1: INSTITUTE ADMIN ROUTES (Session Auth + Super Admin Only)
// Base: /api/v1/institute/*
// ============================================

/**
 * @route   POST /api/v1/institute/generate-credentials
 * @desc    Generate API credentials for institutional user
 * @access  Private - Super Admin only (requires JWT token)
 */
router.post(
  '/generate-credentials',
  protect,
  instituteApiController.generateApiCredentials
);

/**
 * @route   GET /api/v1/institute/clients
 * @desc    List all API clients
 * @access  Private - Super Admin only (requires JWT token)
 */
router.get(
  '/clients',
  protect,
  instituteApiController.listApiClients
);

/**
 * @route   DELETE /api/v1/institute/clients/:id/revoke
 * @desc    Revoke API credentials
 * @access  Private - Super Admin only (requires JWT token)
 */
router.delete(
  '/clients/:id/revoke',
  protect,
  instituteApiController.revokeApiCredentials
);

/**
 * @route   POST /api/v1/institute/clients/:id/regenerate
 * @desc    Regenerate API credentials
 * @access  Private - Super Admin only (requires JWT token)
 */
router.post(
  '/clients/:id/regenerate',
  protect,
  instituteApiController.regenerateApiCredentials
);

// ============================================
// SECTION 2: EXTERNAL INSTITUTE API ROUTES (API Key Auth)
// Base: /api/v1/external/*
// These routes REQUIRE X-API-Key and X-API-Secret headers
// ============================================

// Apply API key authentication to ALL external routes
router.use('/external', apiKeyAuth);

/**
 * @route   GET /api/v1/external/bookings
 * @desc    Get all bookings for external institute
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/bookings', bookingController.getAllBookings);

/**
 * @route   GET /api/v1/external/branches
 * @desc    Get all branches for external institute
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/branches', branchController.getBranches);

/**
 * @route   GET /api/v1/external/health
 * @desc    Health check for institute API
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Institute API is operational',
    institute: req.apiClient?.instituteName,
    user: req.instituteUser?.name,
    timestamp: new Date().toISOString(),
    endpoints: {
      bookings: '/api/v1/external/bookings',
      branches: '/api/v1/external/branches',
      health: '/api/v1/external/health',
    },
  });
});

// ---------- External: Sales & Booking Reports ----------

/**
 * @route   GET /api/v1/external/reports/branch-sales
 * @desc    Branch sales report with allocation date filtering
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/branch-sales', generateBranchSalesReport);

/**
 * @route   GET /api/v1/external/reports/subdealer-sales
 * @desc    Subdealer sales report with allocation date filtering
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/subdealer-sales', generateSubdealerSalesReport);

/**
 * @route   GET /api/v1/external/reports/bookings
 * @desc    Booking report (excludes allocated bookings)
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/bookings', generateBookingReport);

/**
 * @route   GET /api/v1/external/reports/booking-allocation
 * @desc    Booking report filtered by allocation date
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/booking-allocation', getBookingAllocationReport);

// ---------- External: Financial Reports ----------

/**
 * @route   GET /api/v1/external/reports/gc
 * @desc    GC (Guarantee Certificate) report
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/gc', generateGCReport);

/**
 * @route   GET /api/v1/external/reports/receipts
 * @desc    Receipt report with filtering
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/receipts', generateReceiptReport);

/**
 * @route   GET /api/v1/external/reports/approved-receipts
 * @desc    Approved receipts filtered by approval date
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/approved-receipts', getApprovedReceipts);

/**
 * @route   GET /api/v1/external/reports/outstanding
 * @desc    Field-based outstanding report
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/outstanding', generateFieldBasedOutstandingReport);

/**
 * @route   GET /api/v1/external/reports/outstanding/verified
 * @desc    Verified-amount outstanding report
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/outstanding/verified', generateVerifiedOutstandingReport);

/**
 * @route   GET /api/v1/external/reports/outstanding/pending-verification
 * @desc    Pending-verification outstanding report
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/outstanding/pending-verification', generatePendingVerificationOutstandingReport);

// ---------- External: Quotation Reports ----------

/**
 * @route   GET /api/v1/external/reports/quotations
 * @desc    Quotation report with filtering
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/quotations', generateQuotationReport);

// ---------- External: Insurance Reports ----------

/**
 * @route   GET /api/v1/external/reports/insurance/pending
 * @desc    Insurance pending report (AWAITING | PENDING | NOT_STARTED | LATER)
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/insurance/pending', generateInsurancePendingReport);

// ---------- External: Stock & Inventory Reports ----------

/**
 * @route   GET /api/v1/external/reports/stock/current
 * @desc    Current stock report at branches / subdealers
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/stock/current', generateCurrentStockReport1);

/**
 * @route   GET /api/v1/external/reports/stock/transfers
 * @desc    Stock transfer report
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/stock/transfers', generateStockTransferReport);

// ---------- External: Exchange & Broker Reports ----------

/**
 * @route   GET /api/v1/external/reports/brokers
 * @desc    Broker report for exchange vehicles
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/brokers', generateBrokerReport);

// ---------- External: Invoice Reports ----------

/**
 * @route   GET /api/v1/external/reports/dummy-invoice
 * @desc    Dummy invoice report
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/dummy-invoice', generateDummyInvoiceReport);

// ---------- External: Subdealer Reports ----------

/**
 * @route   GET /api/v1/external/reports/subdealer-allocations
 * @desc    Subdealer payment allocation report
 * @access  External - Requires valid API Key & Secret
 * @headers X-API-Key, X-API-Secret
 */
router.get('/external/subdealer-allocations', generateSubdealerPaymentAllocationReport);
// ─── Individual KPI routes ────────────────────────────────────────────────────
 
/**
 * @route  GET /api/v1/dashboard/inventory
 * @desc   Inventory KPIs: Total, Open, Booked, Wholesale, Ageing(>90D)
 * @query  branchId, subdealerId, locationType, modelType
 * @access Private
 */
router.get('/external/inventory', getInventoryKPIs);
 
/**
 * @route  GET /api/v1/dashboard/cross-sell
 * @desc   Cross-Sell KPIs: Car Finance, Insurance, Exchange, Accessories Sale, Acc. Per Car
 * @query  branchId, startDate, endDate, modelType
 * @access Private
 */
router.get('/external/cross-sell', getCrossSellKPIs);
 
/**
 * @route  GET /api/v1/dashboard/sales-management
 * @desc   Sales Management KPIs: Bookings, Dlr. Retail, OEM Retail, POC Sales
 * @query  branchId, startDate, endDate, modelType
 * @access Private
 */
router.get('/external/sales-management', getSalesManagementKPIs);
 
// ─── Combined route ───────────────────────────────────────────────────────────
 
/**
 * @route  GET /api/v1/dashboard/sales-summary
 * @desc   All Sales Dashboard KPIs in one call (Inventory + Cross-Sell + Sales Management)
 * @query  branchId, subdealerId, startDate, endDate, modelType, locationType
 * @access Private
 */
router.get('/external/sales-summary', getSalesDashboardSummary);
// ============================================
// EXPORT
// ============================================
module.exports = router;