const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const Vehicle = require('../models/vehicleInwardModel');
const Branch = require('../models/Branch');
const Subdealer = require('../models/Subdealer');
const User = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Get accessible branch IDs for the requesting user
// ─────────────────────────────────────────────────────────────────────────────
async function getAccessibleBranchIds(user) {
  const userRoles = user.roles || [];
  const isActualSuperAdmin = userRoles.some(r => r.name === 'SUPERADMIN');
  const isSuperAdminFlag = userRoles.some(r => r.isSuperAdmin === true);
  const branchAccess = user.branchAccess || 'OWN';

  const hasAllBranchesAccess = isActualSuperAdmin || branchAccess === 'ALL' || isSuperAdminFlag;

  if (hasAllBranchesAccess) return null; // null = no restriction

  if (branchAccess === 'ASSIGNED' && user.accessibleBranches?.length) {
    return user.accessibleBranches.map(b => b._id);
  }

  if (user.branch?._id) return [user.branch._id];

  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Build date range query
// ─────────────────────────────────────────────────────────────────────────────
function buildDateRange(startDate, endDate) {
  if (!startDate && !endDate) return null;
  const range = {};
  if (startDate) {
    const s = new Date(startDate);
    s.setHours(0, 0, 0, 0);
    range.$gte = s;
  }
  if (endDate) {
    const e = new Date(endDate);
    e.setHours(23, 59, 59, 999);
    range.$lte = e;
  }
  return range;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Fetch and populate user
// ─────────────────────────────────────────────────────────────────────────────
async function getUser(userId) {
  return User.findById(userId)
    .select('-otp -otpExpires -emailOtp -emailOtpExpires -password')
    .populate({ path: 'roles', select: 'name isSuperAdmin' })
    .populate('branch')
    .populate({ path: 'accessibleBranches', model: 'Branch', select: '_id name' })
    .lean();
}

// ─────────────────────────────────────────────────────────────────────────────
// API 1: INVENTORY DASHBOARD KPIs
// GET /api/v1/dashboard/inventory
//
// KPIs Covered:
//   - Total Inventory  : all vehicles (any status) at a location
//   - Open Inventory   : vehicles with status = 'in_stock' (not booked/blocked)
//   - Booked Inventory : vehicles with status = 'booked' or 'blocked'
//   - Wholesale        : vehicles with status = 'in_transit' (bulk from OEM/transferred)
//   - Ageing (>90D)    : vehicles with ageInDays > 90 and status = 'in_stock'
//
// Query Params:
//   branchId, subdealerId, locationType ('branch'|'subdealer'|'both'), modelType, startDate, endDate
// ─────────────────────────────────────────────────────────────────────────────
exports.getInventoryKPIs = async (req, res) => {
  try {
    const { branchId, subdealerId, locationType = 'both', modelType } = req.query;

    const userId = req.user.id;
    const user = await getUser(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const accessibleBranchIds = await getAccessibleBranchIds(user);

    // ── Build location filter ──────────────────────────────────────────────
    let locationFilter = {};

    if (locationType === 'branch') {
      locationFilter.locationType = 'branch';

      if (branchId && branchId !== 'all') {
        const reqId = new mongoose.Types.ObjectId(branchId);
        if (accessibleBranchIds !== null) {
          const ok = accessibleBranchIds.some(id => id.toString() === reqId.toString());
          if (!ok) return res.status(403).json({ success: false, message: 'Access denied to this branch' });
        }
        locationFilter.unloadLocation = reqId;
      } else if (accessibleBranchIds !== null) {
        locationFilter.unloadLocation = { $in: accessibleBranchIds };
      }

    } else if (locationType === 'subdealer') {
      locationFilter.locationType = 'subdealer';

      if (subdealerId && subdealerId !== 'all') {
        locationFilter.subdealerLocation = new mongoose.Types.ObjectId(subdealerId);
      }
      // branch-based restriction for subdealers
      if (accessibleBranchIds !== null) {
        const subs = await Subdealer.find({
          branch: { $in: accessibleBranchIds },
          status: 'active'
        }).select('_id').lean();
        const subIds = subs.map(s => s._id);
        if (subdealerId && subdealerId !== 'all') {
          const reqSubId = new mongoose.Types.ObjectId(subdealerId);
          const ok = subIds.some(id => id.toString() === reqSubId.toString());
          if (!ok) return res.status(403).json({ success: false, message: 'Access denied to this subdealer' });
        } else {
          locationFilter.subdealerLocation = { $in: subIds };
        }
      }

    } else {
      // BOTH
      const orConditions = [];

      // Branch side
      const branchCond = { locationType: 'branch' };
      if (branchId && branchId !== 'all') {
        branchCond.unloadLocation = new mongoose.Types.ObjectId(branchId);
      } else if (accessibleBranchIds !== null) {
        branchCond.unloadLocation = { $in: accessibleBranchIds };
      }
      orConditions.push(branchCond);

      // Subdealer side
      const subCond = { locationType: 'subdealer' };
      if (subdealerId && subdealerId !== 'all') {
        subCond.subdealerLocation = new mongoose.Types.ObjectId(subdealerId);
      } else if (accessibleBranchIds !== null) {
        const subs = await Subdealer.find({
          branch: { $in: accessibleBranchIds },
          status: 'active'
        }).select('_id').lean();
        subCond.subdealerLocation = { $in: subs.map(s => s._id) };
      }
      orConditions.push(subCond);

      locationFilter.$or = orConditions;
    }

    // ── Optional model type filter ─────────────────────────────────────────
    if (modelType) {
      const models = await mongoose.model('Model').find({
        type: modelType.toUpperCase()
      }).select('_id').lean();
      locationFilter.model = { $in: models.map(m => m._id) };
    }

    // ── Aggregate ─────────────────────────────────────────────────────────
    const pipeline = [
      { $match: locationFilter },
      {
        $group: {
          _id: null,
          totalInventory:   { $sum: 1 },
          openInventory:    { $sum: { $cond: [{ $eq: ['$status', 'in_stock'] }, 1, 0] } },
          bookedInventory:  { $sum: { $cond: [{ $in: ['$status', ['booked', 'blocked']] }, 1, 0] } },
          wholesale:        { $sum: { $cond: [{ $eq: ['$status', 'in_transit'] }, 1, 0] } },
          ageing90Plus:     {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: ['$ageInDays', 90] },
                    { $eq: ['$status', 'in_stock'] }
                  ]
                },
                1,
                0
              ]
            }
          }
        }
      }
    ];

    const [result] = await Vehicle.aggregate(pipeline);

    // ── Breakdown by model type ────────────────────────────────────────────
    const modelBreakdown = await Vehicle.aggregate([
      { $match: { ...locationFilter, status: 'in_stock' } },
      {
        $lookup: {
          from: 'models',
          localField: 'model',
          foreignField: '_id',
          as: 'modelDoc'
        }
      },
      { $unwind: { path: '$modelDoc', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$modelDoc.type',
          count: { $sum: 1 }
        }
      }
    ]);

    const kpis = {
      totalInventory:  result?.totalInventory  || 0,
      openInventory:   result?.openInventory   || 0,
      bookedInventory: result?.bookedInventory || 0,
      wholesale:       result?.wholesale       || 0,
      ageing90Plus:    result?.ageing90Plus    || 0,
      modelTypeBreakdown: modelBreakdown.reduce((acc, item) => {
        acc[item._id || 'UNKNOWN'] = item.count;
        return acc;
      }, {})
    };

    return res.status(200).json({
      success: true,
      kpis,
      filters: { locationType, branchId, subdealerId, modelType }
    });

  } catch (error) {
    console.error('Error in getInventoryKPIs:', error);
    res.status(500).json({ success: false, message: 'Error fetching inventory KPIs', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// API 2: CROSS-SELL DASHBOARD KPIs
// GET /api/v1/dashboard/cross-sell
//
// KPIs Covered (from Booking model):
//   - vehicle Finance        : bookings where payment.type = 'FINANCE'
//   - Insurance          : bookings where insuranceStatus = 'COMPLETED'
//   - Exchange           : bookings where exchange = true
//   - Accessories Sale   : total accessories revenue across bookings
//   - Acc. Per vehicle       : average accessories revenue per allocated booking
//
// Query Params: branchId, startDate, endDate, modelType
// ─────────────────────────────────────────────────────────────────────────────
exports.getCrossSellKPIs = async (req, res) => {
  try {
    const { branchId, startDate, endDate, modelType } = req.query;

    const userId = req.user.id;
    const user = await getUser(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const accessibleBranchIds = await getAccessibleBranchIds(user);

    // ── Build booking filter ───────────────────────────────────────────────
    const filter = {
      status: 'ALLOCATED' // Only count retail-sold vehicles
    };

    // Branch filter
    if (branchId && branchId !== 'all') {
      const reqId = new mongoose.Types.ObjectId(branchId);
      if (accessibleBranchIds !== null) {
        const ok = accessibleBranchIds.some(id => id.toString() === reqId.toString());
        if (!ok) return res.status(403).json({ success: false, message: 'Access denied to this branch' });
      }
      filter.branch = reqId;
    } else if (accessibleBranchIds !== null) {
      filter.branch = { $in: accessibleBranchIds };
    }

    // Date range on createdAt
    const dateRange = buildDateRange(startDate, endDate);
    if (dateRange) filter.createdAt = dateRange;

    // Model type filter
    if (modelType) {
      const models = await mongoose.model('Model').find({
        type: modelType.toUpperCase()
      }).select('_id').lean();
      filter.model = { $in: models.map(m => m._id) };
    }

    // ── Aggregate cross-sell KPIs ──────────────────────────────────────────
    const [result] = await Booking.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalBookings:     { $sum: 1 },
          financeCount:      { $sum: { $cond: [{ $eq: ['$payment.type', 'FINANCE'] }, 1, 0] } },
          insuranceCount:    {
            $sum: { $cond: [{ $eq: ['$insuranceStatus', 'COMPLETED'] }, 1, 0] }
          },
          exchangeCount:     { $sum: { $cond: ['$exchange', 1, 0] } },
          accessoriesTotal:  { $sum: { $ifNull: ['$accessoriesTotal', 0] } }
        }
      }
    ]);

    const totalBookings      = result?.totalBookings    || 0;
    const financeCount       = result?.financeCount     || 0;
    const insuranceCount     = result?.insuranceCount   || 0;
    const exchangeCount      = result?.exchangeCount    || 0;
    const accessoriesTotal   = result?.accessoriesTotal || 0;
    const accPervehicle          = totalBookings > 0
      ? parseFloat((accessoriesTotal / totalBookings).toFixed(2))
      : 0;

    return res.status(200).json({
      success: true,
      kpis: {
        vehicleFinance:      financeCount,
        insurance:       insuranceCount,
        exchange:        exchangeCount,
        accessoriesSale: parseFloat(accessoriesTotal.toFixed(2)),
        accPervehicle,
        totalAllocated:  totalBookings
      },
      filters: { branchId, startDate, endDate, modelType }
    });

  } catch (error) {
    console.error('Error in getCrossSellKPIs:', error);
    res.status(500).json({ success: false, message: 'Error fetching cross-sell KPIs', error: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// API 3: SALES MANAGEMENT DASHBOARD KPIs
// GET /api/v1/dashboard/sales-management
//
// KPIs Covered:
//   - Bookings        : total bookings created in period (all statuses except CANCELLED)
//   - Dlr. Retail     : bookings with bookingType = 'BRANCH' and status = 'ALLOCATED'
//   - OEM Retail      : bookings with bookingType = 'SUBDEALER' and status = 'ALLOCATED'
//     (Vehicles retailed through subdealers shown to OEM)
//   - POC Sales       : bookings with customerType = 'CSD' (Pre-Owned/CSD sales channel)
//
// Also returns breakdown by model type, by RTO, by payment type
//
// Query Params: branchId, startDate, endDate, modelType
// ─────────────────────────────────────────────────────────────────────────────
/**
 * GET SALES MANAGEMENT - RAW BOOKINGS DATA API
 * 
 * @description Fetches all bookings with complete details (NO analytics/KPIs)
 * @route GET /api/sales/bookings/raw
 * 
 * @param {string} branchId - Filter by branch ID (optional, 'all' for all branches)
 * @param {string} subdealerId - Filter by subdealer ID (optional)
 * @param {string} startDate - Filter by start date (YYYY-MM-DD)
 * @param {string} endDate - Filter by end date (YYYY-MM-DD)
 * @param {string} modelType - Filter by model type (ICE/EV)
 * @param {string} bookingType - Filter by booking type (BRANCH/SUBDEALER)
 * @param {string} status - Filter by booking status
 * @param {string} customerType - Filter by customer type (B2B/B2C/CSD)
 * @param {string} paymentType - Filter by payment type (CASH/FINANCE)
 * 
 * @returns {Object} Response with raw bookings data only
 */
exports.getSalesManagementKPIs = async (req, res) => {
  try {
    const {
      branchId,
      subdealerId,
      startDate,
      endDate,
      modelType,
      bookingType,
      status,
      customerType,
      paymentType
    } = req.query;

    const userId = req.user.id;
    
    // ========== USER AUTH & ACCESS ==========
    const user = await User.findById(userId)
      .select('-otp -otpExpires -emailOtp -emailOtpExpires -password')
      .populate({ path: 'roles', select: 'name isSuperAdmin permissionsCount' })
      .populate('branch')
      .populate({ path: 'accessibleBranches', model: 'Branch', select: '_id name' })
      .populate({ path: 'assignedSubdealers', model: 'Subdealer', select: '_id name firmName' })
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const roleNames = (user.roles || []).map(role => role.name);
    const isActualSuperAdmin = roleNames.includes('SUPERADMIN');
    const isSuperAdminFlag = (user.roles || []).some(role => role.isSuperAdmin === true);
    const isADBDM = roleNames.includes('ADBDM');
    const branchAccess = user.branchAccess || 'OWN';
    const hasAllBranchesAccess = isActualSuperAdmin || branchAccess === 'ALL' || isSuperAdminFlag;

    // ========== BUILD BASE FILTER ==========
    const baseFilter = {
      status: {
        $nin: ['CANCELLED', 'CANCELLED_APPROVE', 'CANCELLED_REJECTED']
      }
    };

    // Date range filter
    if (startDate || endDate) {
      baseFilter.createdAt = {};
      if (startDate) {
        baseFilter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        baseFilter.createdAt.$lte = new Date(endDate);
      }
    }

    // Branch access filter
    if (!hasAllBranchesAccess) {
      if (branchAccess === 'ASSIGNED' && user.accessibleBranches?.length) {
        const accessibleBranchIds = user.accessibleBranches.map(b => b._id);
        baseFilter.branch = { $in: accessibleBranchIds };
      } else if (user.branch) {
        baseFilter.branch = user.branch._id;
      } else {
        return res.status(200).json({
          success: true,
          data: [],
          totalCount: 0,
          filters: req.query,
          metadata: {
            userAccess: {
              role: roleNames,
              hasAllBranchesAccess,
              branchAccess
            },
            generatedAt: new Date().toISOString()
          }
        });
      }
    }

    // Apply filters
    if (branchId && branchId !== 'all') {
      baseFilter.branch = new mongoose.Types.ObjectId(branchId);
    }
    if (subdealerId && subdealerId !== 'all') {
      baseFilter.subdealer = new mongoose.Types.ObjectId(subdealerId);
    }
    if (bookingType && bookingType !== 'all') {
      baseFilter.bookingType = bookingType;
    }
    if (status && status !== 'all') {
      baseFilter.status = status;
    }
    if (customerType && customerType !== 'all') {
      baseFilter.customerType = customerType;
    }
    if (paymentType && paymentType !== 'all') {
      baseFilter['payment.type'] = paymentType;
    }

    // Model type filter
    if (modelType && modelType !== 'all') {
      const models = await mongoose.model('Model').find({
        type: modelType.toUpperCase()
      }).select('_id').lean();
      
      if (models.length > 0) {
        baseFilter.model = { $in: models.map(m => m._id) };
      }
    }

    // ========== FETCH ALL BOOKINGS ==========
    const bookings = await Booking.find(baseFilter)
      .populate('model', 'model_name model_type type')
      .populate('color', 'name')
      .populate('branch', 'name address city')
      .populate('subdealer', 'name firmName')
      .populate('salesExecutive', 'name email mobile')
      .populate('subdealerUser', 'name email mobile')
      .populate('createdBy', 'name email')
      .populate('payment.financer', 'name')
      .populate('exchangeDetails.broker', 'name mobile')
      .populate('vehicle', 'chassisNumber engineNumber batteryNumber keyNumber')
      .sort({ createdAt: -1 })
      .lean();

    // ========== FORMAT RAW BOOKINGS DATA (NO KPIs) ==========
    const formattedBookings = bookings.map(booking => ({
      // ========== BOOKING IDENTIFIERS ==========
      id: booking._id,
      bookingNumber: booking.bookingNumber,
      bookingDate: booking.createdAt,
      bookingType: booking.bookingType,
      status: booking.status,
      
      // ========== CUSTOMER DETAILS ==========
      customer: {
        id: booking.customerDetails?.custId,
        name: booking.customerDetails?.name,
        salutation: booking.customerDetails?.salutation,
        mobile: booking.customerDetails?.mobile1,
        alternateMobile: booking.customerDetails?.mobile2,
        email: booking.customerDetails?.email,
        type: booking.customerType,
        gstin: booking.gstin,
        panNo: booking.customerDetails?.panNo,
        aadharNumber: booking.customerDetails?.aadharNumber,
        dob: booking.customerDetails?.dob,
        occupation: booking.customerDetails?.occupation,
        address: booking.customerDetails?.address,
        taluka: booking.customerDetails?.taluka,
        district: booking.customerDetails?.district,
        pincode: booking.customerDetails?.pincode,
        nomineeName: booking.customerDetails?.nomineeName,
        nomineeRelation: booking.customerDetails?.nomineeRelation,
        nomineeAge: booking.customerDetails?.nomineeAge
      },
      
      // ========== VEHICLE DETAILS ==========
      vehicle: {
        model: {
          id: booking.model?._id,
          name: booking.model?.model_name,
          type: booking.model?.type,
          modelType: booking.model?.model_type
        },
        color: {
          id: booking.color?._id,
          name: booking.color?.name
        },
        chassisNumber: booking.chassisNumber || booking.vehicle?.chassisNumber,
        engineNumber: booking.vehicle?.engineNumber || booking.engineNumber,
        batteryNumber: booking.batteryNumber || booking.vehicle?.batteryNumber,
        keyNumber: booking.keyNumber || booking.vehicle?.keyNumber,
        motorNumber: booking.motorNumber || booking.vehicle?.motorNumber,
        chargerNumber: booking.chargerNumber || booking.vehicle?.chargerNumber,
        allocationStatus: booking.chassisAllocationStatus,
        vehicleRef: booking.vehicleRef
      },
      
      // ========== PRICE BREAKDOWN ==========
      pricing: {
        totalAmount: booking.totalAmount,
        discountedAmount: booking.discountedAmount,
        receivedAmount: booking.receivedAmount,
        balanceAmount: booking.balanceAmount,
        subsidyAmount: booking.subsidyAmount,
        accessoriesTotal: booking.accessoriesTotal,
        rtoAmount: booking.rtoAmount,
        hypothecationCharges: booking.hypothecationCharges
      },
      
      // ========== PAYMENT DETAILS ==========
      payment: {
        type: booking.payment?.type,
        financier: {
          id: booking.payment?.financer?._id,
          name: booking.payment?.financer?.name
        },
        scheme: booking.payment?.scheme,
        emiPlan: booking.payment?.emiPlan,
        gcApplicable: booking.payment?.gcApplicable,
        gcAmount: booking.payment?.gcAmount
      },
      
      // ========== EXCHANGE DETAILS ==========
      exchange: {
        isExchange: booking.exchange,
        vehicleNumber: booking.exchangeDetails?.vehicleNumber,
        chassisNumber: booking.exchangeDetails?.chassisNumber,
        price: booking.exchangeDetails?.price,
        broker: {
          id: booking.exchangeDetails?.broker?._id,
          name: booking.exchangeDetails?.broker?.name,
          mobile: booking.exchangeDetails?.broker?.mobile
        },
        otpVerified: booking.exchangeDetails?.otpVerified,
        status: booking.exchangeDetails?.status,
        completedAt: booking.exchangeDetails?.completedAt
      },
      
      // ========== ACCESSORIES ==========
      accessories: {
        total: booking.accessoriesTotal,
        items: (booking.accessories || []).map(acc => ({
          id: acc.accessory?._id,
          name: acc.accessory?.name,
          code: acc.accessory?.code,
          category: acc.accessory?.category,
          price: acc.price,
          discount: acc.discount,
          netAmount: (acc.price || 0) - (acc.discount || 0),
          isAdjustment: acc.isAdjustment
        }))
      },
      
      // ========== RTO DETAILS ==========
      rto: {
        type: booking.rto,
        code: booking.rtoCode,
        amount: booking.rtoAmount,
        status: booking.rtoStatus,
        hpa: booking.hpa,
        hypothecationCharges: booking.hypothecationCharges
      },
      
      // ========== INSURANCE DETAILS ==========
      insurance: {
        selfInsurance: booking.selfInsurance,
        insuranceFivePlusFive: booking.insuranceFivePlusFive,
        selfInsuranceDecision: booking.selfInsuranceDecision,
        selfInsuranceApproved: booking.selfInsuranceApproved,
        status: booking.insuranceStatus
      },
      
      // ========== DOCUMENT STATUS FIELDS ==========
      documentStatus: {
        kycStatus: booking.kycStatus,
        financeLetterStatus: booking.financeLetterStatus,
        dealFormStatus: booking.dealFormStatus,
        deliveryChallanStatus: booking.deliveryChallanStatus,
        formGenerated: booking.formGenerated,
        formPath: booking.formPath,
        qrCode: booking.qrCode
      },
      
      // ========== CLAIM DETAILS ==========
      claim: {
        hasClaim: booking.claimDetails?.hasClaim,
        priceClaim: booking.claimDetails?.priceClaim,
        description: booking.claimDetails?.description,
        createdAt: booking.claimDetails?.createdAt
      },
      
      // ========== DEVIATIONS ==========
      deviations: {
        isDeviation: booking.is_deviation === 'YES',
        deviationAmount: booking.deviationAmount,
        gmDeviations: (booking.gmDeviations || []).map(dev => ({
          amount: dev.amount,
          type: dev.type,
          reason: dev.reason,
          note: dev.note,
          status: dev.status,
          appliedAt: dev.appliedAt
        })),
        managerDeviations: (booking.managerDeviations || []).map(dev => ({
          amount: dev.amount,
          type: dev.type,
          reason: dev.reason,
          note: dev.note,
          appliedAt: dev.appliedAt
        }))
      },
      
      // ========== SOURCE INFORMATION ==========
      source: {
        type: booking.bookingType,
        branch: booking.branch ? {
          id: booking.branch._id,
          name: booking.branch.name,
          address: booking.branch.address,
          city: booking.branch.city
        } : null,
        subdealer: booking.subdealer ? {
          id: booking.subdealer._id,
          name: booking.subdealer.firmName || booking.subdealer.name
        } : null,
        salesExecutive: booking.salesExecutive ? {
          id: booking.salesExecutive._id,
          name: booking.salesExecutive.name,
          email: booking.salesExecutive.email,
          mobile: booking.salesExecutive.mobile
        } : null,
        subdealerUser: booking.subdealerUser ? {
          id: booking.subdealerUser._id,
          name: booking.subdealerUser.name,
          email: booking.subdealerUser.email,
          mobile: booking.subdealerUser.mobile
        } : null,
        createdBy: {
          id: booking.createdBy?._id,
          name: booking.createdBy?.name,
          email: booking.createdBy?.email
        }
      },
      
      // ========== CANCELLATION DETAILS ==========
      cancellation: booking.cancellationRequest?.status !== 'NOTHING' ? {
        status: booking.cancellationRequest?.status,
        requestedAt: booking.cancellationRequest?.requestedAt,
        requestedBy: booking.cancellationRequest?.requestedBy,
        reason: booking.cancellationRequest?.reason,
        cancellationCharges: booking.cancellationRequest?.cancellationCharges,
        refundAmount: booking.cancellationRequest?.refundAmount,
        completedAt: booking.cancellationRequest?.completedAt
      } : null,
      
      // ========== TIMESTAMPS ==========
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
      approvedAt: booking.approvedAt,
      allocationDate: booking.allocationDate
    }));

    // ========== RESPONSE WITH RAW DATA ONLY (NO KPIs) ==========
    return res.status(200).json({
      success: true,
      data: formattedBookings,
      totalCount: bookings.length,
      filters: {
        branchId: branchId || 'all',
        subdealerId: subdealerId || 'all',
        startDate: startDate || null,
        endDate: endDate || null,
        modelType: modelType || 'all',
        bookingType: bookingType || 'all',
        status: status || 'all',
        customerType: customerType || 'all',
        paymentType: paymentType || 'all'
      },
      metadata: {
        userAccess: {
          role: roleNames,
          hasAllBranchesAccess,
          branchAccess,
          isADBDM
        },
        generatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error fetching raw bookings data:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching raw bookings data', 
      error: error.message 
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// API 4: COMBINED SALES DASHBOARD — All KPIs in one call
// GET /api/v1/dashboard/sales-summary
//
// Returns all three sections (Inventory + CrossSell + SalesManagement) in
// a single response to minimize round-trips for dashboard rendering.
//
// Query Params: branchId, startDate, endDate, modelType, locationType
// ─────────────────────────────────────────────────────────────────────────────
exports.getSalesDashboardSummary = async (req, res) => {
  try {
    const { branchId, subdealerId, startDate, endDate, modelType, locationType = 'both' } = req.query;

    const userId = req.user.id;
    const user = await getUser(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const accessibleBranchIds = await getAccessibleBranchIds(user);

    // ── Shared booking filter ──────────────────────────────────────────────
    const bookingBase = {
      status: { $nin: ['CANCELLED', 'CANCELLED_APPROVE', 'CANCELLED_REJECTED'] }
    };

    if (branchId && branchId !== 'all') {
      const reqId = new mongoose.Types.ObjectId(branchId);
      if (accessibleBranchIds !== null) {
        const ok = accessibleBranchIds.some(id => id.toString() === reqId.toString());
        if (!ok) return res.status(403).json({ success: false, message: 'Access denied to this branch' });
      }
      bookingBase.branch = reqId;
    } else if (accessibleBranchIds !== null) {
      bookingBase.branch = { $in: accessibleBranchIds };
    }

    const dateRange = buildDateRange(startDate, endDate);
    if (dateRange) bookingBase.createdAt = dateRange;

    if (modelType) {
      const models = await mongoose.model('Model').find({ type: modelType.toUpperCase() }).select('_id').lean();
      bookingBase.model = { $in: models.map(m => m._id) };
    }

    // ── Vehicle (inventory) filter ─────────────────────────────────────────
    const vehicleFilter = {};

    if (locationType === 'branch') {
      vehicleFilter.locationType = 'branch';
      if (branchId && branchId !== 'all') {
        vehicleFilter.unloadLocation = new mongoose.Types.ObjectId(branchId);
      } else if (accessibleBranchIds !== null) {
        vehicleFilter.unloadLocation = { $in: accessibleBranchIds };
      }
    } else if (locationType === 'subdealer') {
      vehicleFilter.locationType = 'subdealer';
      if (subdealerId && subdealerId !== 'all') {
        vehicleFilter.subdealerLocation = new mongoose.Types.ObjectId(subdealerId);
      }
    } else {
      // Both
      const orParts = [];
      const bCond = { locationType: 'branch' };
      if (branchId && branchId !== 'all') {
        bCond.unloadLocation = new mongoose.Types.ObjectId(branchId);
      } else if (accessibleBranchIds !== null) {
        bCond.unloadLocation = { $in: accessibleBranchIds };
      }
      orParts.push(bCond);

      const sCond = { locationType: 'subdealer' };
      if (subdealerId && subdealerId !== 'all') {
        sCond.subdealerLocation = new mongoose.Types.ObjectId(subdealerId);
      } else if (accessibleBranchIds !== null) {
        const subs = await Subdealer.find({
          branch: { $in: accessibleBranchIds },
          status: 'active'
        }).select('_id').lean();
        sCond.subdealerLocation = { $in: subs.map(s => s._id) };
      }
      orParts.push(sCond);
      vehicleFilter.$or = orParts;
    }

    if (modelType) {
      const models = await mongoose.model('Model').find({ type: modelType.toUpperCase() }).select('_id').lean();
      vehicleFilter.model = { $in: models.map(m => m._id) };
    }

    // ── Run all aggregations in parallel ─────────────────────────────────
    const [inventoryResult, bookingResult] = await Promise.all([
      Vehicle.aggregate([
        { $match: vehicleFilter },
        {
          $group: {
            _id: null,
            totalInventory:  { $sum: 1 },
            openInventory:   { $sum: { $cond: [{ $eq: ['$status', 'in_stock'] }, 1, 0] } },
            bookedInventory: { $sum: { $cond: [{ $in: ['$status', ['booked', 'blocked']] }, 1, 0] } },
            wholesale:       { $sum: { $cond: [{ $eq: ['$status', 'in_transit'] }, 1, 0] } },
            ageing90Plus:    {
              $sum: {
                $cond: [
                  { $and: [{ $gt: ['$ageInDays', 90] }, { $eq: ['$status', 'in_stock'] }] },
                  1, 0
                ]
              }
            }
          }
        }
      ]),
      Booking.aggregate([
        { $match: bookingBase },
        {
          $group: {
            _id: null,
            totalBookings:    { $sum: 1 },
            totalAllocated:   { $sum: { $cond: [{ $eq: ['$status', 'ALLOCATED'] }, 1, 0] } },
            dlrRetail:        {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$bookingType', 'BRANCH'] }, { $eq: ['$status', 'ALLOCATED'] }] },
                  1, 0
                ]
              }
            },
            oemRetail:        {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$bookingType', 'SUBDEALER'] }, { $eq: ['$status', 'ALLOCATED'] }] },
                  1, 0
                ]
              }
            },
            pocSales:         { $sum: { $cond: [{ $eq: ['$customerType', 'CSD'] }, 1, 0] } },
            financeCount:     { $sum: { $cond: [{ $eq: ['$payment.type', 'FINANCE'] }, 1, 0] } },
            insuranceCount:   { $sum: { $cond: [{ $eq: ['$insuranceStatus', 'COMPLETED'] }, 1, 0] } },
            exchangeCount:    { $sum: { $cond: ['$exchange', 1, 0] } },
            accessoriesTotal: { $sum: { $ifNull: ['$accessoriesTotal', 0] } }
          }
        }
      ])
    ]);

    const inv = inventoryResult[0] || {};
    const bk  = bookingResult[0]   || {};

    const totalAllocated  = bk.totalAllocated || 0;
    const accessoriesTotal = bk.accessoriesTotal || 0;

    return res.status(200).json({
      success: true,
      dashboard: {
        inventory: {
          totalInventory:  inv.totalInventory  || 0,
          openInventory:   inv.openInventory   || 0,
          bookedInventory: inv.bookedInventory || 0,
          wholesale:       inv.wholesale       || 0,
          ageing90Plus:    inv.ageing90Plus    || 0
        },
        crossSell: {
          vehicleFinance:      bk.financeCount   || 0,
          insurance:       bk.insuranceCount || 0,
          exchange:        bk.exchangeCount  || 0,
          accessoriesSale: parseFloat(accessoriesTotal.toFixed(2)),
          accPervehicle:       totalAllocated > 0
            ? parseFloat((accessoriesTotal / totalAllocated).toFixed(2))
            : 0
        },
        salesManagement: {
          totalBookings:  bk.totalBookings || 0,
          dlrRetail:      bk.dlrRetail     || 0,
          oemRetail:      bk.oemRetail     || 0,
          pocSales:       bk.pocSales      || 0,
          totalAllocated
        }
      },
      filters: { branchId, subdealerId, startDate, endDate, modelType, locationType }
    });

  } catch (error) {
    console.error('Error in getSalesDashboardSummary:', error);
    res.status(500).json({ success: false, message: 'Error fetching dashboard summary', error: error.message });
  }
};
  
/**
 * GET CURRENT STOCK - RAW VEHICLES DATA API
 * 
 * @description Fetches all vehicles with complete details (NO analytics/KPIs)
 * @route GET /api/stock/vehicles/raw
 * 
 * @param {string} branchId - Filter by branch ID (optional)
 * @param {string} subdealerId - Filter by subdealer ID (optional)
 * @param {string} locationType - 'branch' | 'subdealer' | 'both'
 * @param {string} modelId - Filter by model ID
 * @param {string} colorId - Filter by color ID
 * @param {string} vehicleType - Filter by vehicle type (EV/ICE)
 * @param {string} modelType - Filter by model type
 * @param {string} status - Filter by vehicle status
 * @param {string} format - 'json' only (excel removed for raw data)
 * 
 * @returns {Object} Response with raw vehicles data only
 */
exports.generateCurrentStockReport1 = async (req, res) => {
    try {
      const {
        branchId,
        subdealerId,
        locationType,
        modelId,
        colorId,
        vehicleType,
        modelType,
        status
      } = req.query;
  
      const filter = {};
  
      // ========== USER AUTH & BRANCH ACCESS ==========
      const userId = req.user.id;
  
      const user = await User.findById(userId)
        .select('-otp -otpExpires -emailOtp -emailOtpExpires -password')
        .populate({ path: 'roles', select: 'name isSuperAdmin permissionsCount' })
        .populate('branch')
        .populate({ path: 'accessibleBranches', model: 'Branch', select: '_id name address city state pincode phone email is_active logo1' })
        .populate({ path: 'assignedSubdealers', model: 'Subdealer', select: '_id name firmName type status branch' })
        .lean();
  
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
  
      const roleNames = (user.roles || []).map(role => role.name);
      const isActualSuperAdmin = roleNames.includes('SUPERADMIN');
      const isSuperAdminFlag = (user.roles || []).some(role => role.isSuperAdmin === true);
      const isADBDM = roleNames.includes('ADBDM');
      const branchAccess = user.branchAccess || 'OWN';
      const hasAllBranchesAccess = isActualSuperAdmin || branchAccess === 'ALL' || isSuperAdminFlag;
  
      // ========== BUILD FILTER ==========
      
      // Branch access filter
      const getUserAccessibleBranchIds = () => {
        if (hasAllBranchesAccess) return null;
        if (branchAccess === 'ASSIGNED' && user.accessibleBranches?.length) {
          return user.accessibleBranches.map(b => b._id);
        }
        if (user.branch) return [user.branch._id];
        return [];
      };
  
      const getUserAccessibleSubdealerIds = async () => {
        if (isADBDM) {
          return user.assignedSubdealers?.map(s => s._id) || [];
        }
        if (hasAllBranchesAccess) return null;
        if (user.branch) {
          const subs = await Subdealer.find({ branch: user.branch._id, status: 'active' }).select('_id').lean();
          return subs.map(s => s._id);
        }
        return [];
      };
  
      const accessibleBranchIds = getUserAccessibleBranchIds();
      const accessibleSubdealerIds = await getUserAccessibleSubdealerIds();
  
      // Apply location filter
      const effectiveLocationType = locationType || 'both';
  
      if (effectiveLocationType === 'branch') {
        filter.locationType = 'branch';
  
        if (branchId && branchId !== 'all') {
          const requestedId = new mongoose.Types.ObjectId(branchId);
          if (accessibleBranchIds !== null) {
            const hasAccess = accessibleBranchIds.some(id => id.toString() === requestedId.toString());
            if (!hasAccess) {
              return res.status(403).json({ success: false, message: 'You do not have access to this branch' });
            }
          }
          filter.unloadLocation = requestedId;
        } else {
          if (accessibleBranchIds !== null) {
            filter.unloadLocation = { $in: accessibleBranchIds };
          }
        }
  
      } else if (effectiveLocationType === 'subdealer') {
        filter.locationType = 'subdealer';
  
        if (subdealerId && subdealerId !== 'all') {
          const requestedId = new mongoose.Types.ObjectId(subdealerId);
          if (accessibleSubdealerIds !== null) {
            const hasAccess = accessibleSubdealerIds.some(id => id.toString() === requestedId.toString());
            if (!hasAccess) {
              return res.status(403).json({ success: false, message: 'You do not have access to this subdealer' });
            }
          }
          filter.subdealerLocation = requestedId;
        } else {
          if (accessibleSubdealerIds !== null) {
            if (accessibleSubdealerIds.length === 0) {
              return res.status(200).json({
                success: true,
                data: [],
                totalCount: 0,
                filters: req.query,
                metadata: {
                  userAccess: {
                    role: roleNames,
                    hasAllBranchesAccess,
                    branchAccess
                  },
                  generatedAt: new Date().toISOString()
                }
              });
            }
            filter.subdealerLocation = { $in: accessibleSubdealerIds };
          }
        }
  
      } else {
        const orConditions = [];
  
        if (branchId && branchId !== 'all') {
          const requestedBranchId = new mongoose.Types.ObjectId(branchId);
          if (accessibleBranchIds !== null) {
            const hasAccess = accessibleBranchIds.some(id => id.toString() === requestedBranchId.toString());
            if (!hasAccess) {
              return res.status(403).json({ success: false, message: 'You do not have access to this branch' });
            }
          }
          orConditions.push({ locationType: 'branch', unloadLocation: requestedBranchId });
        } else {
          if (accessibleBranchIds !== null && accessibleBranchIds.length > 0) {
            orConditions.push({ locationType: 'branch', unloadLocation: { $in: accessibleBranchIds } });
          } else if (accessibleBranchIds === null) {
            orConditions.push({ locationType: 'branch' });
          }
        }
  
        if (subdealerId && subdealerId !== 'all') {
          const requestedSubdealerId = new mongoose.Types.ObjectId(subdealerId);
          if (accessibleSubdealerIds !== null) {
            const hasAccess = accessibleSubdealerIds.some(id => id.toString() === requestedSubdealerId.toString());
            if (!hasAccess) {
              return res.status(403).json({ success: false, message: 'You do not have access to this subdealer' });
            }
          }
          orConditions.push({ locationType: 'subdealer', subdealerLocation: requestedSubdealerId });
        } else {
          if (accessibleSubdealerIds !== null && accessibleSubdealerIds.length > 0) {
            orConditions.push({ locationType: 'subdealer', subdealerLocation: { $in: accessibleSubdealerIds } });
          } else if (accessibleSubdealerIds === null) {
            orConditions.push({ locationType: 'subdealer' });
          }
        }
  
        if (orConditions.length === 0) {
          return res.status(200).json({
            success: true,
            data: [],
            totalCount: 0,
            filters: req.query,
            metadata: {
              userAccess: {
                role: roleNames,
                hasAllBranchesAccess,
                branchAccess
              },
              generatedAt: new Date().toISOString()
            }
          });
        }
  
        filter.$or = orConditions;
      }
  
      // Apply other filters
      if (modelId && modelId !== 'all') {
        filter.model = new mongoose.Types.ObjectId(modelId);
      }
      if (colorId && colorId !== 'all') {
        filter['color.id'] = new mongoose.Types.ObjectId(colorId);
      }
      if (vehicleType && vehicleType !== 'all') {
        filter.type = vehicleType.toUpperCase();
      }
      if (status && status !== 'all') {
        filter.status = status;
      }
  
      // Model type filter
      if (modelType && modelType !== 'all') {
        const models = await mongoose.model('Model').find({
          $or: [{ model_type: modelType.toUpperCase() }, { type: modelType.toUpperCase() }]
        }).select('_id').lean();
  
        const modelTypeFilterIds = models.map(m => m._id);
  
        if (modelTypeFilterIds.length > 0) {
          filter.model = { $in: modelTypeFilterIds };
        }
      }
  
      // ========== FETCH ALL VEHICLES ==========
      const vehicles = await Vehicle.find(filter)
        .populate('model', 'model_name manufacturer variant fuel_type type model_type')
        .populate('colors', 'name hex_code')
        .populate('color.id', 'name hex_code')
        .populate('unloadLocation', 'name address city state')
        .populate('subdealerLocation', 'name location rateOfInterest type branch')
        .populate('addedBy', 'name email')
        .populate('lastUpdatedBy', 'name email')
        .sort({ inwardDate: 1, chassisNumber: 1 })
        .lean();
  
      // ========== FORMAT RAW VEHICLES DATA (NO KPIs) ==========
      const formattedVehicles = vehicles.map(vehicle => {
        let locationName = '';
        let locationTypeValue = '';
        let locationId = null;
  
        if (vehicle.locationType === 'branch' && vehicle.unloadLocation) {
          locationName = vehicle.unloadLocation.name || '';
          locationTypeValue = 'Branch';
          locationId = vehicle.unloadLocation._id;
        } else if (vehicle.locationType === 'subdealer' && vehicle.subdealerLocation) {
          locationName = vehicle.subdealerLocation.name || '';
          locationTypeValue = 'Subdealer';
          locationId = vehicle.subdealerLocation._id;
        } else if (vehicle.locationType === 'yard') {
          locationName = 'Yard';
          locationTypeValue = 'Yard';
        }
  
        // Calculate age in days
        const ageInDays = vehicle.ageInDays || Math.floor((Date.now() - new Date(vehicle.inwardDate)) / (1000 * 60 * 60 * 24));
  
        return {
          // ========== VEHICLE IDENTIFIERS ==========
          id: vehicle._id,
          chassisNumber: vehicle.chassisNumber,
          engineNumber: vehicle.engineNumber,
          qrCode: vehicle.qrCode,
          
          // ========== MODEL DETAILS ==========
          model: {
            id: vehicle.model?._id,
            name: vehicle.model?.model_name || vehicle.modelName,
            manufacturer: vehicle.model?.manufacturer,
            variant: vehicle.model?.variant,
            fuelType: vehicle.model?.fuel_type,
            type: vehicle.model?.type,
            modelType: vehicle.model?.model_type || vehicle.model?.type
          },
          
          // ========== COLOR DETAILS ==========
          color: {
            id: vehicle.color?.id,
            name: vehicle.color?.name,
            hexCode: vehicle.color?.id?.hex_code
          },
          
          // ========== VEHICLE SPECIFICATIONS ==========
          vehicleType: vehicle.type,           // "EV" or "ICE"
          batteryNumber: vehicle.batteryNumber,
          keyNumber: vehicle.keyNumber,
          motorNumber: vehicle.motorNumber,
          chargerNumber: vehicle.chargerNumber,
          
          // ========== LOCATION DETAILS ==========
          location: {
            type: locationTypeValue,            // "Branch", "Subdealer", "Yard"
            name: locationName,
            id: locationId,
            branchDetails: vehicle.unloadLocation ? {
              id: vehicle.unloadLocation._id,
              name: vehicle.unloadLocation.name,
              address: vehicle.unloadLocation.address,
              city: vehicle.unloadLocation.city,
              state: vehicle.unloadLocation.state,
              pincode: vehicle.unloadLocation.pincode
            } : null,
            subdealerDetails: vehicle.subdealerLocation ? {
              id: vehicle.subdealerLocation._id,
              name: vehicle.subdealerLocation.name,
              location: vehicle.subdealerLocation.location,
              rateOfInterest: vehicle.subdealerLocation.rateOfInterest,
              type: vehicle.subdealerLocation.type,
              branch: vehicle.subdealerLocation.branch
            } : null
          },
          
          // ========== STATUS DETAILS ==========
          status: vehicle.status,               // "in_stock", "booked", "blocked", "sold", etc.
          allocationStatus: {
            isAllocated: !!(vehicle.allocatedBooking || vehicle.customerName),
            customerName: vehicle.customerName,
            bookingId: vehicle.allocatedBooking,
            bookingReceivedAmount: vehicle.bookingReceivedAmount,
            requiredMinAmount: vehicle.requiredMinAmount,
            minAmountPercentage: vehicle.minAmountPercentage
          },
          
          // ========== INWARD DETAILS ==========
          inwardDate: vehicle.inwardDate,
          ageInDays: ageInDays,
          isUnder10DaysCluster: ageInDays <= 10,
          fifoRank: vehicle.fifoRank || 0,
          
          // ========== DAMAGE DETAILS ==========
          hasDamage: vehicle.hasDamage || false,
          damages: (vehicle.damages || []).map(damage => ({
            description: damage.description,
            images: damage.images,
            reportedAt: damage.reportedAt,
            reportedBy: damage.reportedBy
          })),
          
          // ========== GM APPROVAL DETAILS ==========
          gmApproval: {
            requiresGmApproval: vehicle.requiresGmApproval || false,
            status: vehicle.gmApprovalStatus || 'NOT_REQUIRED',
            approvedBy: vehicle.gmApprovedBy,
            approvedAt: vehicle.gmApprovedAt,
            rejectionReason: vehicle.gmRejectionReason,
            note: vehicle.gmApprovalNote
          },
          
          // ========== FREEZE DETAILS ==========
          freezeInfo: vehicle.freezeInfo ? {
            isFrozen: vehicle.freezeInfo.isFrozen,
            frozenAt: vehicle.freezeInfo.frozenAt,
            frozenUntil: vehicle.freezeInfo.frozenUntil,
            frozenBy: vehicle.freezeInfo.frozenBy,
            frozenReason: vehicle.freezeInfo.frozenReason,
            originalStatus: vehicle.freezeInfo.originalStatus,
            autoUnfrozenAt: vehicle.freezeInfo.autoUnfrozenAt
          } : null,
          
          // ========== ALLOCATION HISTORY ==========
          allocationHistory: (vehicle.allocationHistory || []).map(history => ({
            bookingId: history.bookingId,
            bookingNumber: history.bookingNumber,
            allocatedAt: history.allocatedAt,
            allocatedBy: history.allocatedBy,
            status: history.status,
            gmApprovalRequired: history.gmApprovalRequired,
            gmApprovalStatus: history.gmApprovalStatus,
            note: history.note
          })),
          
          // ========== UNBLOCK HISTORY ==========
          unblockHistory: (vehicle.unblockHistory || []).map(history => ({
            unblockedAt: history.unblockedAt,
            unblockedBy: history.unblockedBy,
            reason: history.reason,
            replacedWithVehicle: history.replacedWithVehicle,
            customerNameAtUnblock: history.customerNameAtUnblock,
            allocatedBookingAtUnblock: history.allocatedBookingAtUnblock
          })),
          
          // ========== BOOKING ELIGIBILITY ==========
          bookingEligibility: vehicle.bookingEligibility ? {
            isEligible: vehicle.bookingEligibility.isEligible,
            message: vehicle.bookingEligibility.eligibilityMessage,
            lastChecked: vehicle.bookingEligibility.lastChecked,
            fifoCompliant: vehicle.bookingEligibility.fifoCompliant,
            olderVehiclesCount: vehicle.bookingEligibility.olderVehiclesCount,
            canSellFreely: vehicle.bookingEligibility.canSellFreely
          } : null,
          
          // ========== AUDIT DETAILS ==========
          addedBy: {
            id: vehicle.addedBy?._id,
            name: vehicle.addedBy?.name,
            email: vehicle.addedBy?.email
          },
          lastUpdatedBy: {
            id: vehicle.lastUpdatedBy?._id,
            name: vehicle.lastUpdatedBy?.name,
            email: vehicle.lastUpdatedBy?.email
          },
          
          // ========== TIMESTAMPS ==========
          createdAt: vehicle.createdAt,
          updatedAt: vehicle.updatedAt
        };
      });
  
      // ========== RESPONSE WITH RAW DATA ONLY (NO KPIs) ==========
      return res.status(200).json({
        success: true,
        data: formattedVehicles,
        totalCount: vehicles.length,
        filters: {
          branchId: branchId || 'all',
          subdealerId: subdealerId || 'all',
          locationType: effectiveLocationType,
          modelId: modelId || 'all',
          colorId: colorId || 'all',
          vehicleType: vehicleType || 'all',
          modelType: modelType || 'all',
          status: status || 'all'
        },
        metadata: {
          userAccess: {
            role: roleNames,
            hasAllBranchesAccess,
            branchAccess,
            isADBDM
          },
          generatedAt: new Date().toISOString()
        }
      });
  
    } catch (error) {
      console.error('Error fetching raw vehicles data:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching raw vehicles data',
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  };

// Helper function for empty response
const _emptyResponse = (res, format, availableBranches, availableSubdealers, userAccessInfo, queryParams, inventorySummary = null) => {
  if (format === 'excel') {
    // Create minimal Excel with summary only
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('No Data Found');
    
    worksheet.getCell('A1').value = 'No vehicles found matching the criteria';
    worksheet.getCell('A1').font = { bold: true, size: 14 };
    
    if (inventorySummary) {
      worksheet.getCell('A3').value = 'Inventory Summary:';
      worksheet.getCell('A3').font = { bold: true };
      worksheet.getCell('A4').value = `Total Inventory: ${inventorySummary.totalInventory}`;
      worksheet.getCell('A5').value = `Open Inventory: ${inventorySummary.openInventory}`;
      worksheet.getCell('A6').value = `Booked Inventory: ${inventorySummary.bookedInventory}`;
      worksheet.getCell('A7').value = `Wholesale: ${inventorySummary.wholesale}`;
      worksheet.getCell('A8').value = `Ageing 90+: ${inventorySummary.ageing90Plus}`;
    }
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="empty_report.xlsx"');
    return workbook.xlsx.write(res).then(() => res.end());
  } else {
    return res.status(200).json({
      success: true,
      count: 0,
      message: 'No vehicles found matching the criteria',
      summary: inventorySummary || {
        totalInventory: 0,
        openInventory: 0,
        bookedInventory: 0,
        wholesale: 0,
        ageing90Plus: 0
      },
      data: [],
      availableBranches,
      availableSubdealers,
      userAccessInfo,
      filters: queryParams
    });
  }
};


  
  // ========== ALTERNATIVE VERSION WITH MORE DETAILS ==========
  exports.getBookingKPIs = async (req, res) => {
    try {
      const {
        branchId,
        subdealerId,
        startDate,
        endDate,
        modelId,
        colorId,
        modelType,
        bookingType,
        status,
        customerType,
        paymentType,
        page = 1,
        limit = 50,
        format = 'json'
      } = req.query;
  
      // ========== USER AUTH & ACCESS ==========
      const userId = req.user.id;
  
      const user = await User.findById(userId)
        .select('-otp -otpExpires -emailOtp -emailOtpExpires -password')
        .populate({ path: 'roles', select: 'name isSuperAdmin permissionsCount' })
        .populate('branch')
        .populate({ path: 'accessibleBranches', model: 'Branch', select: '_id name' })
        .populate({ path: 'assignedSubdealers', model: 'Subdealer', select: '_id name firmName' })
        .lean();
  
      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }
  
      const roleNames = (user.roles || []).map(role => role.name);
      const isActualSuperAdmin = roleNames.includes('SUPERADMIN');
      const isSuperAdminFlag = (user.roles || []).some(role => role.isSuperAdmin === true);
      const isADBDM = roleNames.includes('ADBDM');
      const branchAccess = user.branchAccess || 'OWN';
      const hasAllBranchesAccess = isActualSuperAdmin || branchAccess === 'ALL' || isSuperAdminFlag;
  
      // ========== BUILD MATCH STAGE ==========
      const matchStage = {};
  
      // Date range filter
      if (startDate || endDate) {
        matchStage.createdAt = {};
        if (startDate) {
          matchStage.createdAt.$gte = new Date(startDate);
        }
        if (endDate) {
          matchStage.createdAt.$lte = new Date(endDate);
        }
      }
  
      // Branch access filter
      if (!hasAllBranchesAccess) {
        if (branchAccess === 'ASSIGNED' && user.accessibleBranches?.length) {
          const accessibleBranchIds = user.accessibleBranches.map(b => b._id);
          matchStage.branch = { $in: accessibleBranchIds };
        } else if (user.branch) {
          matchStage.branch = user.branch._id;
        } else {
          return res.status(200).json({
            success: true,
            kpis: {
              totalBookings: 0,
              dlrRetail: 0,
              oemRetail: 0,
              pocSales: 0,
              totalAllocated: 0,
              cashPayments: 0,
              financePayments: 0
            },
            breakdown: {
              byModelType: {},
              byStatus: {},
              byBookingType: {},
              byCustomerType: {}
            },
            data: [],
            pagination: {
              page: parseInt(page),
              limit: parseInt(limit),
              total: 0,
              pages: 0
            },
            filters: {
              branchId: branchId || 'all',
              startDate: startDate || null,
              endDate: endDate || null
            }
          });
        }
      }
  
      // Branch filter
      if (branchId && branchId !== 'all') {
        matchStage.branch = new mongoose.Types.ObjectId(branchId);
      }
  
      // Subdealer filter
      if (subdealerId && subdealerId !== 'all') {
        matchStage.subdealer = new mongoose.Types.ObjectId(subdealerId);
      }
  
      // Booking type filter (BRANCH/SUBDEALER)
      if (bookingType && bookingType !== 'all') {
        matchStage.bookingType = bookingType;
      }
  
      // Status filter
      if (status && status !== 'all') {
        matchStage.status = status;
      }
  
      // Customer type filter
      if (customerType && customerType !== 'all') {
        matchStage.customerType = customerType;
      }
  
      // Payment type filter
      if (paymentType && paymentType !== 'all') {
        matchStage['payment.type'] = paymentType;
      }
  
      // Model filter
      if (modelId && modelId !== 'all') {
        matchStage.model = new mongoose.Types.ObjectId(modelId);
      }
  
      // Color filter
      if (colorId && colorId !== 'all') {
        matchStage.color = new mongoose.Types.ObjectId(colorId);
      }
  
      // Model type filter
      let modelTypeFilterIds = null;
      if (modelType && modelType !== 'all') {
        const models = await mongoose.model('Model').find({
          $or: [{ model_type: modelType.toUpperCase() }, { type: modelType.toUpperCase() }]
        }).select('_id').lean();
        
        modelTypeFilterIds = models.map(m => m._id);
        if (modelTypeFilterIds.length > 0) {
          matchStage.model = { $in: modelTypeFilterIds };
        }
      }
  
      console.log('📊 Booking KPIs Match Stage:', JSON.stringify(matchStage, null, 2));
  
      // ========== GET TOTAL COUNT FOR PAGINATION ==========
      const totalCount = await Booking.countDocuments(matchStage);
      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const skip = (pageNum - 1) * limitNum;
      const totalPages = Math.ceil(totalCount / limitNum);
  
      // ========== FETCH BOOKINGS DATA WITH POPULATION ==========
      const bookings = await Booking.find(matchStage)
        .populate('model', 'model_name model_type type')
        .populate('color', 'name')
        .populate('branch', 'name address city')
        .populate('subdealer', 'name firmName')
        .populate('salesExecutive', 'name email mobile')
        .populate('subdealerUser', 'name email mobile')
        .populate('createdBy', 'name email')
        .populate('payment.financer', 'name')
        .populate('exchangeDetails.broker', 'name mobile')
        .populate('vehicle', 'chassisNumber engineNumber batteryNumber keyNumber')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean();
  
      // ========== AGGREGATION PIPELINE FOR KPIs ==========
      const pipeline = [
        { $match: matchStage },
        {
          $lookup: {
            from: 'models',
            localField: 'model',
            foreignField: '_id',
            as: 'modelInfo'
          }
        },
        {
          $addFields: {
            modelTypeValue: { $arrayElemAt: ['$modelInfo.model_type', 0] },
            modelTypeAlt: { $arrayElemAt: ['$modelInfo.type', 0] },
            finalModelType: {
              $ifNull: [
                { $arrayElemAt: ['$modelInfo.model_type', 0] },
                { $arrayElemAt: ['$modelInfo.type', 0] },
                'UNKNOWN'
              ]
            },
            isBranchBooking: { $eq: ['$bookingType', 'BRANCH'] },
            isSubdealerBooking: { $eq: ['$bookingType', 'SUBDEALER'] },
            isApprovedOrCompleted: {
              $in: ['$status', ['APPROVED', 'COMPLETED', 'ALLOCATED']]
            },
            hasChassisNumber: {
              $and: [
                { $ne: ['$chassisNumber', null] },
                { $ne: ['$chassisNumber', ''] }
              ]
            },
            isAllocated: { $eq: ['$chassisAllocationStatus', 'ALLOCATED'] },
            isCashPayment: { $eq: ['$payment.type', 'CASH'] },
            isFinancePayment: { $eq: ['$payment.type', 'FINANCE'] }
          }
        },
        {
          $facet: {
            totalBookings: [{ $count: 'count' }],
            dlrRetail: [
              { $match: { isBranchBooking: true, isApprovedOrCompleted: true } },
              { $count: 'count' }
            ],
            oemRetail: [
              { $match: { isSubdealerBooking: true, isApprovedOrCompleted: true } },
              { $count: 'count' }
            ],
            pocSales: [
              { $match: { hasChassisNumber: true, isApprovedOrCompleted: true } },
              { $count: 'count' }
            ],
            totalAllocated: [
              { $match: { isAllocated: true } },
              { $count: 'count' }
            ],
            cashPayments: [
              { $match: { isCashPayment: true, isApprovedOrCompleted: true } },
              { $count: 'count' }
            ],
            financePayments: [
              { $match: { isFinancePayment: true, isApprovedOrCompleted: true } },
              { $count: 'count' }
            ],
            byModelType: [
              {
                $group: {
                  _id: '$finalModelType',
                  count: { $sum: 1 }
                }
              },
              { $sort: { count: -1 } },
              {
                $group: {
                  _id: null,
                  data: {
                    $push: {
                      k: '$_id',
                      v: '$count'
                    }
                  }
                }
              },
              {
                $replaceRoot: {
                  newRoot: { $arrayToObject: '$data' }
                }
              }
            ],
            byStatus: [
              {
                $group: {
                  _id: { $ifNull: ['$status', 'UNKNOWN'] },
                  count: { $sum: 1 }
                }
              },
              { $sort: { count: -1 } },
              {
                $group: {
                  _id: null,
                  data: {
                    $push: {
                      k: '$_id',
                      v: '$count'
                    }
                  }
                }
              },
              {
                $replaceRoot: {
                  newRoot: { $arrayToObject: '$data' }
                }
              }
            ],
            byBookingType: [
              {
                $group: {
                  _id: { $ifNull: ['$bookingType', 'UNKNOWN'] },
                  count: { $sum: 1 }
                }
              },
              {
                $group: {
                  _id: null,
                  data: {
                    $push: {
                      k: '$_id',
                      v: '$count'
                    }
                  }
                }
              },
              {
                $replaceRoot: {
                  newRoot: { $arrayToObject: '$data' }
                }
              }
            ],
            byCustomerType: [
              {
                $group: {
                  _id: { $ifNull: ['$customerType', 'UNKNOWN'] },
                  count: { $sum: 1 }
                }
              },
              {
                $group: {
                  _id: null,
                  data: {
                    $push: {
                      k: '$_id',
                      v: '$count'
                    }
                  }
                }
              },
              {
                $replaceRoot: {
                  newRoot: { $arrayToObject: '$data' }
                }
              }
            ],
            byMonth: [
              {
                $group: {
                  _id: {
                    $dateToString: { format: '%Y-%m', date: '$createdAt' }
                  },
                  count: { $sum: 1 }
                }
              },
              { $sort: { _id: 1 } },
              {
                $group: {
                  _id: null,
                  data: {
                    $push: {
                      k: '$_id',
                      v: '$count'
                    }
                  }
                }
              },
              {
                $replaceRoot: {
                  newRoot: { $arrayToObject: '$data' }
                }
              }
            ]
          }
        },
        {
          $project: {
            totalBookings: { $arrayElemAt: ['$totalBookings.count', 0] },
            dlrRetail: { $arrayElemAt: ['$dlrRetail.count', 0] },
            oemRetail: { $arrayElemAt: ['$oemRetail.count', 0] },
            pocSales: { $arrayElemAt: ['$pocSales.count', 0] },
            totalAllocated: { $arrayElemAt: ['$totalAllocated.count', 0] },
            cashPayments: { $arrayElemAt: ['$cashPayments.count', 0] },
            financePayments: { $arrayElemAt: ['$financePayments.count', 0] },
            byModelType: { $arrayElemAt: ['$byModelType', 0] },
            byStatus: { $arrayElemAt: ['$byStatus', 0] },
            byBookingType: { $arrayElemAt: ['$byBookingType', 0] },
            byCustomerType: { $arrayElemAt: ['$byCustomerType', 0] },
            byMonth: { $arrayElemAt: ['$byMonth', 0] }
          }
        }
      ];
  
      // Execute aggregation for KPIs
      const results = await Booking.aggregate(pipeline);
      let kpisData = results[0] || {};
      
      const safeValue = (val) => val || 0;
      
      const byModelTypeObj = kpisData.byModelType || {};
      const byStatusObj = kpisData.byStatus || {};
      const byBookingTypeObj = kpisData.byBookingType || {};
      const byCustomerTypeObj = kpisData.byCustomerType || {};
      const byMonthObj = kpisData.byMonth || {};
  
      // ========== FORMAT BOOKINGS DATA ==========
      const formattedBookings = bookings.map(booking => {
        return {
          id: booking._id,
          bookingNumber: booking.bookingNumber,
          bookingDate: booking.createdAt,
          bookingType: booking.bookingType,
          status: booking.status,
          customerName: booking.customerDetails?.name,
          customerMobile: booking.customerDetails?.mobile1,
          customerType: booking.customerType,
          model: booking.model?.model_name,
          modelType: booking.model?.type,
          color: booking.color?.name,
          chassisNumber: booking.chassisNumber || booking.vehicle?.chassisNumber,
          engineNumber: booking.vehicle?.engineNumber || booking.engineNumber,
          paymentType: booking.payment?.type,
          financier: booking.payment?.financer?.name,
          totalAmount: booking.totalAmount,
          discountedAmount: booking.discountedAmount,
          receivedAmount: booking.receivedAmount,
          balanceAmount: booking.balanceAmount,
          exchange: booking.exchange,
          exchangeAmount: booking.exchangeDetails?.price,
          source: booking.bookingType === 'BRANCH' 
            ? { branchId: booking.branch?._id, branchName: booking.branch?.name }
            : { subdealerId: booking.subdealer?._id, subdealerName: booking.subdealer?.firmName || booking.subdealer?.name },
          salesExecutive: booking.bookingType === 'BRANCH' 
            ? booking.salesExecutive?.name 
            : booking.subdealerUser?.name,
          rto: booking.rto,
          rtoAmount: booking.rtoAmount,
          allocationStatus: booking.chassisAllocationStatus,
          allocatedAt: booking.allocationDate,
          createdAt: booking.createdAt,
          updatedAt: booking.updatedAt
        };
      });
  
      // ========== RESPONSE WITH DATA ==========
      const response = {
        success: true,
        kpis: {
          totalBookings: safeValue(kpisData.totalBookings),
          dlrRetail: safeValue(kpisData.dlrRetail),
          oemRetail: safeValue(kpisData.oemRetail),
          pocSales: safeValue(kpisData.pocSales),
          totalAllocated: safeValue(kpisData.totalAllocated),
          cashPayments: safeValue(kpisData.cashPayments),
          financePayments: safeValue(kpisData.financePayments)
        },
        breakdown: {
          byModelType: byModelTypeObj,
          byStatus: byStatusObj,
          byBookingType: byBookingTypeObj,
          byCustomerType: byCustomerTypeObj,
          byMonth: byMonthObj
        },
        data: formattedBookings,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          pages: totalPages,
          hasNextPage: pageNum < totalPages,
          hasPrevPage: pageNum > 1
        },
        filters: {
          branchId: branchId || 'all',
          subdealerId: subdealerId || 'all',
          startDate: startDate || null,
          endDate: endDate || null,
          modelId: modelId || null,
          colorId: colorId || null,
          modelType: modelType || null,
          bookingType: bookingType || 'all',
          status: status || 'all',
          customerType: customerType || 'all',
          paymentType: paymentType || 'all'
        },
        metadata: {
          totalBookingsCount: totalCount,
          userAccess: {
            role: roleNames,
            hasAllBranchesAccess,
            branchAccess
          },
          generatedAt: new Date().toISOString()
        }
      };
  
      return res.status(200).json(response);
  
    } catch (error) {
      console.error('Error generating booking KPIs:', error);
      res.status(500).json({
        success: false,
        message: 'Error generating booking KPIs',
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  };