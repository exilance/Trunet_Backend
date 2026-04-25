import StockRequest from "../models/StockRequest.js";
import Center from "../models/Center.js";
import User from "../models/User.js";
import StockPurchase from "../models/StockPurchase.js";
import CenterStock from "../models/CenterStock.js";
import mongoose from "mongoose";

const checkStockRequestPermissions = (req, requiredPermissions = []) => {
  const userPermissions = req.user.role?.permissions || [];
  const indentModule = userPermissions.find((perm) => perm.module === "Indent");

  if (!indentModule) {
    return { hasAccess: false, permissions: {} };
  }

  const permissions = {
    manage_indent: indentModule.permissions.includes("manage_indent"),
    indent_all_center: indentModule.permissions.includes("indent_all_center"),
    indent_own_center: indentModule.permissions.includes("indent_own_center"),
    delete_indent_all_center: indentModule.permissions.includes(
      "delete_indent_all_center"
    ),
    delete_indent_own_center: indentModule.permissions.includes(
      "delete_indent_own_center"
    ),
    stock_transfer_approve_from_outlet: indentModule.permissions.includes(
      "stock_transfer_approve_from_outlet"
    ),
    complete_indent: indentModule.permissions.includes("complete_indent"),
  };

  const hasRequiredPermission = requiredPermissions.some(
    (perm) => permissions[perm]
  );

  return {
    hasAccess: hasRequiredPermission,
    permissions,
    userCenter: req.user.center,
  };
};

const checkCenterAccess = (stockRequest, userCenter, permissions) => {
  if (permissions.indent_all_center) {
    return true;
  }

  if (permissions.indent_own_center && userCenter) {
    const userCenterId = userCenter._id || userCenter;
    const requestCenterId = stockRequest.center._id || stockRequest.center;
    return userCenterId.toString() === requestCenterId.toString();
  }

  return false;
};

const getOutletStockForRequests = async (warehouseId, productIds) => {
  try {
    const OutletStock = mongoose.model("OutletStock");
    
    const outletStockData = await OutletStock.find({
      outlet: warehouseId,
      product: { $in: productIds }
    })
    .populate("outlet", "centerName centerCode")
    .select("product totalQuantity availableQuantity inTransitQuantity serialNumbers");
    
    const outletStockMap = new Map();
    
    outletStockData.forEach((item) => {
      // Get available serials (status: "available")
      const availableSerials = item.serialNumbers
        .filter(sn => sn.status === "available")
        .map(sn => sn.serialNumber);
      
      outletStockMap.set(item.product.toString(), {
        totalQuantity: item.totalQuantity,
        availableQuantity: item.availableQuantity,
        inTransitQuantity: item.inTransitQuantity,
        hasSerialNumbers: item.serialNumbers.length > 0,
        availableSerials: availableSerials,
        availableSerialsCount: availableSerials.length,
        outletName: item.outlet?.centerName || "Unknown Outlet"
      });
    });

    return outletStockMap;
  } catch (error) {
    console.error("Error fetching outlet stock for requests:", error);
    throw error;
  }
};

export const createStockRequest = async (req, res) => {
  try {
    const { hasAccess, permissions } = checkStockRequestPermissions(req, [
      "manage_indent",
    ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. manage_indent permission required.",
      });
    }
    const {
      warehouse,
      remark,
      products,
      status = "Draft",
      orderNumber,
      date,
    } = req.body;

    if (!orderNumber || orderNumber.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Order number is required",
      });
    }

    const trimmedOrderNumber = orderNumber.trim();

    const existingRequest = await StockRequest.findOne({
      orderNumber: trimmedOrderNumber,
    });

    if (existingRequest) {
      return res.status(409).json({
        success: false,
        message:
          "Order number already exists. Please use a unique order number.",
        duplicateOrderNumber: trimmedOrderNumber,
        existingRequestId: existingRequest._id,
      });
    }

    let requestDate = new Date();
    if (date) {
      requestDate = new Date(date);
      if (isNaN(requestDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid date format. Please provide a valid date.",
        });
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const providedDate = new Date(requestDate);
      providedDate.setHours(0, 0, 0, 0);
    }

    const user = await User.findById(req.user.id).populate("center");
    if (!user || !user.center) {
      return res.status(400).json({
        success: false,
        message: "User center information not found",
      });
    }

    const centerId = user.center._id;

    if (permissions.indent_own_center && !permissions.indent_all_center) {
      const userCenterId = user.center._id || user.center;
    }

    const centerExists = await Center.findById(centerId);
    if (!centerExists) {
      return res.status(404).json({
        success: false,
        message: "Center not found",
      });
    }

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Products array is required and cannot be empty",
      });
    }

    for (const product of products) {
      if (!product.product || !product.quantity) {
        return res.status(400).json({
          success: false,
          message: "Each product must have product ID and quantity",
        });
      }

      if (product.quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: "Product quantity must be greater than 0",
        });
      }
    }

    const stockRequest = new StockRequest({
      orderNumber: trimmedOrderNumber,
      warehouse,
      center: centerId,
      remark: remark || "",
      products,
      date: requestDate,
      status,
      centerChallanApproval: "pending",
      warehouseChallanApproval: "pending",
      createdBy: req.user.id,
    });

    const savedStockRequest = await stockRequest.save();

    const populatedRequest = await StockRequest.findById(savedStockRequest._id)
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode centerType")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate("createdBy", "_id fullName email")
      .populate("approvalInfo.approvedBy", "_id fullName email")
      .populate("approvalInfo.warehouseChallanApprovedBy","_id fullName email" )
      .populate("approvalInfo.centerChallanApprovedBy","_id fullName email" )
      .populate("shippingInfo.shippedBy", "_id fullName email")
      .populate("receivingInfo.receivedBy", "_id fullName email");

    res.status(201).json({
      success: true,
      message: "Stock request created successfully",
      data: populatedRequest,
    });
  } catch (error) {
    console.error("Error creating stock request:", error);

    if (error.code === 11000) {
      const duplicateField = Object.keys(error.keyPattern)[0];
      if (duplicateField === "orderNumber") {
        return res.status(409).json({
          success: false,
          message:
            "Order number already exists. Please use a unique order number.",
          duplicateOrderNumber: req.body.orderNumber,
        });
      }
    }

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: `Invalid ${error.path}: ${error.value}`,
      });
    }

    res.status(500).json({
      success: false,
      message: "Error creating stock request",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

const getDateRange = (rangeType, customStartDate, customEndDate) => {
  const now = new Date();
  let start = new Date();
  let end = new Date();

  switch (rangeType) {
    case "Today":
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case "Yesterday":
      start.setDate(now.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      end.setDate(now.getDate() - 1);
      end.setHours(23, 59, 59, 999);
      break;
    case "This Week":
      start.setDate(now.getDate() - now.getDay());
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case "Last Week":
      start.setDate(now.getDate() - now.getDay() - 7);
      start.setHours(0, 0, 0, 0);
      end.setDate(now.getDate() - now.getDay() - 1);
      end.setHours(23, 59, 59, 999);
      break;
    case "This Month":
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      end.setHours(23, 59, 59, 999);
      break;
    case "Last Month":
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      start.setHours(0, 0, 0, 0);
      end = new Date(now.getFullYear(), now.getMonth(), 0);
      end.setHours(23, 59, 59, 999);
      break;
    case "This Year":
      start = new Date(now.getFullYear(), 0, 1);
      start.setHours(0, 0, 0, 0);
      end = new Date(now.getFullYear(), 11, 31);
      end.setHours(23, 59, 59, 999);
      break;
    case "Last Year":
      start = new Date(now.getFullYear() - 1, 0, 1);
      start.setHours(0, 0, 0, 0);
      end = new Date(now.getFullYear() - 1, 11, 31);
      end.setHours(23, 59, 59, 999);
      break;
    case "Custom":
      if (customStartDate) start = new Date(customStartDate);
      if (customEndDate) end = new Date(customEndDate);
      break;
    default:
      return null;
  }

  return { start, end };
};

const buildArrayFilter = (value) => {
  if (!value) return null;
  return value.includes(",")
    ? { $in: value.split(",").map((item) => item.trim()) }
    : value;
};

const buildDateFilter = (
  dateFilter,
  customStartDate,
  customEndDate,
  startDate,
  endDate
) => {
  if (dateFilter) {
    const dateRange = getDateRange(dateFilter, customStartDate, customEndDate);
    if (dateRange) {
      return {
        $gte: dateRange.start,
        $lte: dateRange.end,
      };
    }
  }

  if (startDate || endDate) {
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);
    return dateFilter;
  }

  return null;
};

const getBulkCenterStock = async (requests) => {
  const centerProductMap = new Map();

  requests.forEach((request) => {
    if (!request.center?._id) return;

    const centerId = request.center._id.toString();
    const productIds = request.products
      .map((p) => p.product?._id)
      .filter(Boolean);

    if (productIds.length > 0) {
      centerProductMap.set(centerId, [
        ...(centerProductMap.get(centerId) || []),
        ...productIds,
      ]);
    }
  });

  const centerStocks = await StockPurchase.aggregate([
    {
      $match: {
        center: {
          $in: Array.from(centerProductMap.keys()).map(
            (id) => new mongoose.Types.ObjectId(id)
          ),
        },
      },
    },
    {
      $group: {
        _id: {
          center: "$center",
          product: "$product",
        },
        totalQuantity: { $sum: "$quantity" },
      },
    },
  ]);

  const stockMap = new Map();
  centerStocks.forEach((stock) => {
    const key = `${stock._id.center}_${stock._id.product}`;
    stockMap.set(key, stock.totalQuantity);
  });

  return stockMap;
};

const buildFilter = (query) => {
  const {
    status,
    center,
    outlet,
    warehouse,
    startDate,
    endDate,
    createdAtStart,
    createdAtEnd,
    orderNumber,
    search,
    dateFilter,
    customStartDate,
    customEndDate,
  } = query;

  const filter = {};

  const statusFilter = buildArrayFilter(status);
  if (statusFilter) filter.status = statusFilter;

  const centerFilter = buildArrayFilter(center);
  if (centerFilter) {
    if (Array.isArray(centerFilter.$in)) {
      filter.center = { 
        $in: centerFilter.$in.map(id => 
          mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
        )
      };
    } else if (mongoose.Types.ObjectId.isValid(centerFilter)) {
      filter.center = new mongoose.Types.ObjectId(centerFilter);
    } else {
      filter.center = centerFilter;
    }
  }

  const warehouseParam = outlet || warehouse;
  if (warehouseParam) {
    const warehouseFilter = buildArrayFilter(warehouseParam);
    if (warehouseFilter) {
      if (Array.isArray(warehouseFilter.$in)) {
        filter.warehouse = { 
          $in: warehouseFilter.$in.map(id => 
            mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
          )
        };
      } else if (mongoose.Types.ObjectId.isValid(warehouseFilter)) {
        filter.warehouse = new mongoose.Types.ObjectId(warehouseFilter);
      } else {
        filter.warehouse = warehouseFilter;
      }
    }
  }

  const dateFilterObj = buildDateFilter(
    dateFilter,
    customStartDate,
    customEndDate,
    startDate,
    endDate
  );
  if (dateFilterObj) filter.date = dateFilterObj;
  if (createdAtStart || createdAtEnd) {
    filter.createdAt = {};
    if (createdAtStart) filter.createdAt.$gte = new Date(createdAtStart);
    if (createdAtEnd) filter.createdAt.$lte = new Date(createdAtEnd);
  }

  const orderNumberFilter = buildArrayFilter(orderNumber);
  if (orderNumberFilter) {
    filter.orderNumber =
      typeof orderNumberFilter === "object"
        ? orderNumberFilter
        : { $regex: orderNumberFilter, $options: "i" };
  }
  if (search) {
    filter.$or = [
      { orderNumber: { $regex: search, $options: "i" } },
      { remark: { $regex: search, $options: "i" } },
      { "products.productRemark": { $regex: search, $options: "i" } },
      { "approvalInfo.approvedRemark": { $regex: search, $options: "i" } },
      { "receivingInfo.receivedRemark": { $regex: search, $options: "i" } },
    ];
  }

  console.log('Final filter:', JSON.stringify(filter, null, 2));
  return filter;
};

const buildSortOptions = (sortBy = "createdAt", sortOrder = "desc") => {
  const validSortFields = [
    "challanNo",
    "challanDate",
    "createdAt",
    "updatedAt",
    "date",
    "orderNumber",
    "status",
    "approvalInfo.approvedAt",
    "shippingInfo.shippedAt",
    "receivingInfo.receivedAt",
  ];

  const actualSortBy = validSortFields.includes(sortBy) ? sortBy : "createdAt";
  return { [actualSortBy]: sortOrder === "desc" ? -1 : 1 };
};

const populateOptions = [
  { path: "warehouse", select: "_id centerName centerCode centerType" },
  { path: "center", select: "_id centerName centerCode centerType",
   
    populate: [
      {
        path: "reseller",
        select: "_id businessName contactNumber name mobile email gstNumber panNumber address1 address2 city state "
      },
      {
        path: "area",
        select: "_id areaName"
      }
    ]
   },
  {
    path: "products.product",
    select: "_id productTitle productCode productPrice salePrice hsnCode",
  },
  { path: "createdBy", select: "_id fullName email" },
  { path: "updatedBy", select: "_id fullName email" },
  { path: "approvalInfo.approvedBy", select: "_id fullName email" },
  { path: "approvalInfo.warehouseChallanApprovedBy", select: "_id fullName email" },
  { path: "approvalInfo.centerChallanApprovedBy", select: "_id fullName email" },
  { path: "shippingInfo.shippedBy", select: "_id fullName email" },
  { path: "receivingInfo.receivedBy", select: "_id fullName email" },
  { path: "completionInfo.completedBy", select: "_id fullName email" },
  { path: "incompleteInfo.incompleteBy", select: "_id fullName email" },

];

// export const getAllStockRequests = async (req, res) => {
//   try {
//     const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
//       req,
//       ["indent_all_center", "indent_own_center"]
//     );

//     if (!hasAccess) {
//       return res.status(403).json({
//         success: false,
//         message:
//           "Access denied. indent_own_center or indent_all_center permission required.",
//       });
//     }
    
//     const {
//       page = 1,
//       limit = 100,
//       sortBy = "createdAt",
//       sortOrder = "desc",
//       ...filterParams
//     } = req.query;

//     let filter = buildFilter(filterParams);

//     if (filterParams.reseller) {
//       const resellerFilter = buildArrayFilter(filterParams.reseller);
//       let centerFilter = {};
      
//       if (resellerFilter) {
//         if (Array.isArray(resellerFilter.$in)) {
//           centerFilter.reseller = { 
//             $in: resellerFilter.$in.map(id => 
//               mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
//             )
//           };
//         } else if (mongoose.Types.ObjectId.isValid(resellerFilter)) {
//           centerFilter.reseller = new mongoose.Types.ObjectId(resellerFilter);
//         } else {
//           centerFilter.reseller = resellerFilter;
//         }

//         const matchingCenters = await Center.find(centerFilter).select('_id');
//         const centerIds = matchingCenters.map(center => center._id);

//         if (centerIds.length > 0) {
//           if (filter.center) {
//             if (filter.center.$in) {
//               filter.center.$in = filter.center.$in.filter(centerId => 
//                 centerIds.some(matchingId => matchingId.toString() === centerId.toString())
//               );
//             } else {
    
//               if (!centerIds.some(id => id.toString() === filter.center.toString())) {
//                 filter.center = { $in: [] };
//               }
//             }
//           } else {
//             filter.center = { $in: centerIds };
//           }
//         } else {
//           filter.center = { $in: [] };
//         }
//       }
//     }

//     if (
//       permissions.indent_own_center &&
//       !permissions.indent_all_center &&
//       userCenter
//     ) {
//       const userCenterId = userCenter._id || userCenter;
//       if (filter.center) {
//         if (filter.center.$in) {
//           filter.center.$in = filter.center.$in.filter(centerId => 
//             centerId.toString() === userCenterId.toString()
//           );
//         } else {
//           if (filter.center.toString() !== userCenterId.toString()) {
//             filter.center = { $in: [] };
//           }
//         }
//       } else {
//         filter.center = userCenterId;
//       }
//     }

//     const sortOptions = buildSortOptions(sortBy, sortOrder);

//     console.log('Final filter for query:', JSON.stringify(filter, null, 2));

//     const [stockRequests, total, statusCounts] = await Promise.all([
//       StockRequest.find(filter)
//         .populate(populateOptions)
//         .sort(sortOptions)
//         .limit(parseInt(limit))
//         .skip((parseInt(page) - 1) * parseInt(limit))
//         .lean(),

//       StockRequest.countDocuments(filter),

//       StockRequest.aggregate([
//         { $match: filter },
//         { $group: { _id: "$status", count: { $sum: 1 } } },
//       ]),
//     ]);

//     if (stockRequests.length === 0) {
//       return res.status(200).json({
//         success: true,
//         message: "No stock requests found",
//         data: [],
//         pagination: {
//           currentPage: parseInt(page),
//           totalPages: 0,
//           totalItems: 0,
//           itemsPerPage: parseInt(limit),
//         },
//         filters: { status: {}, total: 0 },
//       });
//     }

//     const stockMap = await getBulkCenterStock(stockRequests);
    
//     // NEW: Get reseller stock data for all centers
//     const resellerStockMap = new Map();
//     const centerToResellerMap = new Map(); // Moved outside if block
    
//     // Collect all center IDs and product IDs for batch reseller stock lookup
//     const centerIds = stockRequests.map(req => req.center?._id).filter(Boolean);
//     const allProductIds = [];
    
//     stockRequests.forEach(request => {
//       request.products.forEach(product => {
//         if (product.product?._id) {
//           allProductIds.push(product.product._id.toString());
//         }
//       });
//     });
    
//     // Get unique product IDs
//     const uniqueProductIds = [...new Set(allProductIds)];
    
//     if (centerIds.length > 0 && uniqueProductIds.length > 0) {
//       // Get centers with their reseller information
//       const centersWithResellers = await Center.find({
//         _id: { $in: centerIds }
//       }).populate('reseller', '_id businessName').select('_id reseller');
      
//       // Create map of center ID to reseller ID
//       centersWithResellers.forEach(center => {
//         if (center.reseller) {
//           centerToResellerMap.set(center._id.toString(), center.reseller._id);
//         }
//       });
      
//       // Get all unique reseller IDs
//       const uniqueResellerIds = [...new Set([...centerToResellerMap.values()])];
      
//       if (uniqueResellerIds.length > 0) {
//         // Fetch reseller stock data in bulk
//         const ResellerStock = mongoose.model("ResellerStock");
//         const resellerStocks = await ResellerStock.find({
//           reseller: { $in: uniqueResellerIds },
//           product: { $in: uniqueProductIds.map(id => new mongoose.Types.ObjectId(id)) }
//         }).lean();
        
//         // Create a map for quick lookup: key = "resellerId_productId"
//         resellerStocks.forEach(stock => {
//           const key = `${stock.reseller}_${stock.product}`;
          
//           // Calculate damage repair and center return quantities from serials
//           let damageRepairCount = 0;
//           let centerReturnCount = 0;
//           let availableSerials = [];
          
//           if (stock.serialNumbers && stock.serialNumbers.length > 0) {
//             // Count by source type from serial numbers
//             const availableSerialsArray = stock.serialNumbers.filter(sn => 
//               sn.status === "available"
//             );
            
//             availableSerials = availableSerialsArray.map(sn => sn.serialNumber);
            
//             damageRepairCount = availableSerialsArray.filter(
//               sn => sn.sourceType === "damage_repair"
//             ).length;
            
//             centerReturnCount = availableSerialsArray.filter(
//               sn => sn.sourceType === "center_return"
//             ).length;
//           } else {
//             // For non-serialized products, use sourceBreakdown
//             damageRepairCount = stock.sourceBreakdown?.damageRepairQuantity || 0;
//             centerReturnCount = stock.sourceBreakdown?.centerReturnQuantity || 0;
//           }
          
//           resellerStockMap.set(key, {
//             totalQuantity: stock.totalQuantity || 0,
//             availableQuantity: stock.availableQuantity || 0,
//             consumedQuantity: stock.consumedQuantity || 0,
//             damagedQuantity: stock.damagedQuantity || 0,
//             repairQuantity: stock.repairQuantity || 0,
//             sourceBreakdown: stock.sourceBreakdown || {
//               damageRepairQuantity: damageRepairCount,
//               centerReturnQuantity: centerReturnCount,
//               directPurchaseQuantity: stock.availableQuantity - damageRepairCount - centerReturnCount
//             },
//             availableSerials: availableSerials,
//             availableSerialsCount: availableSerials.length,
//             damageRepairSerialsCount: damageRepairCount,
//             centerReturnSerialsCount: centerReturnCount
//           });
//         });
//       }
//     }

//     const stockRequestsWithEnhancedData = stockRequests.map((request) => {
//       const centerId = request.center?._id?.toString();
//       const resellerId = centerId ? centerToResellerMap.get(centerId) : null;
      
//       const productsWithEnhancedData = request.products.map((product) => {
//         if (!product.product?._id || !request.center?._id) return product;

//         const stockKey = `${request.center._id}_${product.product._id}`;
//         const centerStockQuantity = stockMap.get(stockKey) || 0;
        
//         // Get reseller stock data
//         let resellerStockInfo = null;
//         if (resellerId) {
//           const resellerStockKey = `${resellerId}_${product.product._id}`;
//           resellerStockInfo = resellerStockMap.get(resellerStockKey);
//         }

//         return {
//           ...product,
//           centerStockQuantity,
//           resellerStock: resellerStockInfo ? {
//             totalQuantity: resellerStockInfo.totalQuantity,
//             availableQuantity: resellerStockInfo.availableQuantity,
//             availableBreakdown: {
//               damageRepair: resellerStockInfo.sourceBreakdown.damageRepairQuantity,
//               centerReturn: resellerStockInfo.sourceBreakdown.centerReturnQuantity,
//               directPurchase: resellerStockInfo.sourceBreakdown.directPurchaseQuantity,
//               total: resellerStockInfo.availableQuantity
//             },
//             sourceBreakdown: resellerStockInfo.sourceBreakdown,
//             availableSerials: resellerStockInfo.availableSerials,
//             availableSerialsCount: resellerStockInfo.availableSerialsCount,
//             damageRepairCount: resellerStockInfo.damageRepairSerialsCount,
//             centerReturnCount: resellerStockInfo.centerReturnSerialsCount,
//             hasResellerStock: true
//           } : {
//             totalQuantity: 0,
//             availableQuantity: 0,
//             availableBreakdown: {
//               damageRepair: 0,
//               centerReturn: 0,
//               directPurchase: 0,
//               total: 0
//             },
//             sourceBreakdown: {
//               damageRepairQuantity: 0,
//               centerReturnQuantity: 0,
//               directPurchaseQuantity: 0
//             },
//             availableSerials: [],
//             availableSerialsCount: 0,
//             damageRepairCount: 0,
//             centerReturnCount: 0,
//             hasResellerStock: false
//           }
//         };
//       });

//       // Calculate totals for the request
//       const resellerStockTotals = productsWithEnhancedData.reduce((totals, product) => {
//         totals.totalAvailable += product.resellerStock.availableQuantity;
//         totals.damageRepair += product.resellerStock.availableBreakdown.damageRepair;
//         totals.centerReturn += product.resellerStock.availableBreakdown.centerReturn;
//         totals.directPurchase += product.resellerStock.availableBreakdown.directPurchase;
//         return totals;
//       }, {
//         totalAvailable: 0,
//         damageRepair: 0,
//         centerReturn: 0,
//         directPurchase: 0
//       });

//       return {
//         ...request,
//         products: productsWithEnhancedData,
//         stockSummary: {
//           centerStock: productsWithEnhancedData.reduce((sum, product) => 
//             sum + product.centerStockQuantity, 0
//           ),
//           resellerStock: {
//             totalAvailable: resellerStockTotals.totalAvailable,
//             breakdown: {
//               damageRepair: resellerStockTotals.damageRepair,
//               centerReturn: resellerStockTotals.centerReturn,
//               directPurchase: resellerStockTotals.directPurchase,
//               percentage: {
//                 damageRepair: resellerStockTotals.totalAvailable > 0 ? 
//                   Math.round((resellerStockTotals.damageRepair / resellerStockTotals.totalAvailable) * 100) : 0,
//                 centerReturn: resellerStockTotals.totalAvailable > 0 ? 
//                   Math.round((resellerStockTotals.centerReturn / resellerStockTotals.totalAvailable) * 100) : 0,
//                 directPurchase: resellerStockTotals.totalAvailable > 0 ? 
//                   Math.round((resellerStockTotals.directPurchase / resellerStockTotals.totalAvailable) * 100) : 0
//               }
//             }
//           },
//           resellerInfo: resellerId ? {
//             hasReseller: true,
//             resellerId: resellerId
//           } : {
//             hasReseller: false
//           }
//         }
//       };
//     });

//     const statusStats = statusCounts.reduce((acc, stat) => {
//       acc[stat._id] = stat.count;
//       return acc;
//     }, {});

//     // Calculate overall statistics across all requests
//     const overallStats = stockRequestsWithEnhancedData.reduce((stats, request) => {
//       stats.totalRequests += 1;
//       stats.totalResellerAvailable += request.stockSummary.resellerStock.totalAvailable;
//       stats.totalDamageRepair += request.stockSummary.resellerStock.breakdown.damageRepair;
//       stats.totalCenterReturn += request.stockSummary.resellerStock.breakdown.centerReturn;
//       stats.totalDirectPurchase += request.stockSummary.resellerStock.breakdown.directPurchase;
      
//       // Count requests with reseller stock
//       if (request.stockSummary.resellerInfo.hasReseller) {
//         stats.requestsWithReseller += 1;
//       }
      
//       return stats;
//     }, {
//       totalRequests: 0,
//       totalResellerAvailable: 0,
//       totalDamageRepair: 0,
//       totalCenterReturn: 0,
//       totalDirectPurchase: 0,
//       requestsWithReseller: 0
//     });

//     res.status(200).json({
//       success: true,
//       message: "Stock requests retrieved successfully",
//       data: stockRequestsWithEnhancedData,
//       pagination: {
//         currentPage: parseInt(page),
//         totalPages: Math.ceil(total / limit),
//         totalItems: total,
//         itemsPerPage: parseInt(limit),
//       },
//       filters: {
//         status: statusStats,
//         total: total,
//       },
//       summary: {
//         overallResellerStock: {
//           totalAvailable: overallStats.totalResellerAvailable,
//           breakdown: {
//             damageRepair: overallStats.totalDamageRepair,
//             centerReturn: overallStats.totalCenterReturn,
//             directPurchase: overallStats.totalDirectPurchase
//           },
//           percentage: {
//             damageRepair: overallStats.totalResellerAvailable > 0 ? 
//               Math.round((overallStats.totalDamageRepair / overallStats.totalResellerAvailable) * 100) : 0,
//             centerReturn: overallStats.totalResellerAvailable > 0 ? 
//               Math.round((overallStats.totalCenterReturn / overallStats.totalResellerAvailable) * 100) : 0,
//             directPurchase: overallStats.totalResellerAvailable > 0 ? 
//               Math.round((overallStats.totalDirectPurchase / overallStats.totalResellerAvailable) * 100) : 0
//           }
//         },
//         requestsWithResellerStock: overallStats.requestsWithReseller,
//         totalRequestsWithReseller: overallStats.totalRequests
//       }
//     });
//   } catch (error) {
//     console.error("Error retrieving stock requests:", error);
//     res.status(500).json({
//       success: false,
//       message: "Error retrieving stock requests",
//       error: error.message,
//     });
//   }
// };


//******************* resolve live reseller stock issue *********************


export const getAllStockRequests = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["indent_all_center", "indent_own_center"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. indent_own_center or indent_all_center permission required.",
      });
    }
    
    const {
      page = 1,
      limit = 100,
      sortBy = "createdAt",
      sortOrder = "desc",
      ...filterParams
    } = req.query;

    let filter = buildFilter(filterParams);

    if (filterParams.reseller) {
      const resellerFilter = buildArrayFilter(filterParams.reseller);
      let centerFilter = {};
      
      if (resellerFilter) {
        if (Array.isArray(resellerFilter.$in)) {
          centerFilter.reseller = { 
            $in: resellerFilter.$in.map(id => 
              mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
            )
          };
        } else if (mongoose.Types.ObjectId.isValid(resellerFilter)) {
          centerFilter.reseller = new mongoose.Types.ObjectId(resellerFilter);
        } else {
          centerFilter.reseller = resellerFilter;
        }

        const matchingCenters = await Center.find(centerFilter).select('_id');
        const centerIds = matchingCenters.map(center => center._id);

        if (centerIds.length > 0) {
          if (filter.center) {
            if (filter.center.$in) {
              filter.center.$in = filter.center.$in.filter(centerId => 
                centerIds.some(matchingId => matchingId.toString() === centerId.toString())
              );
            } else {
              if (!centerIds.some(id => id.toString() === filter.center.toString())) {
                filter.center = { $in: [] };
              }
            }
          } else {
            filter.center = { $in: centerIds };
          }
        } else {
          filter.center = { $in: [] };
        }
      }
    }

    if (
      permissions.indent_own_center &&
      !permissions.indent_all_center &&
      userCenter
    ) {
      const userCenterId = userCenter._id || userCenter;
      if (filter.center) {
        if (filter.center.$in) {
          filter.center.$in = filter.center.$in.filter(centerId => 
            centerId.toString() === userCenterId.toString()
          );
        } else {
          if (filter.center.toString() !== userCenterId.toString()) {
            filter.center = { $in: [] };
          }
        }
      } else {
        filter.center = userCenterId;
      }
    }

    const sortOptions = buildSortOptions(sortBy, sortOrder);

    console.log('Final filter for query:', JSON.stringify(filter, null, 2));

    const [stockRequests, total, statusCounts] = await Promise.all([
      StockRequest.find(filter)
        .populate(populateOptions)
        .sort(sortOptions)
        .limit(parseInt(limit))
        .skip((parseInt(page) - 1) * parseInt(limit))
        .lean(),

      StockRequest.countDocuments(filter),

      StockRequest.aggregate([
        { $match: filter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    if (stockRequests.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No stock requests found",
        data: [],
        pagination: {
          currentPage: parseInt(page),
          totalPages: 0,
          totalItems: 0,
          itemsPerPage: parseInt(limit),
        },
        filters: { status: {}, total: 0 },
      });
    }

    const stockMap = await getBulkCenterStock(stockRequests);
    
    // Get reseller stock data for all centers
    const resellerStockMap = new Map();
    const centerToResellerMap = new Map();
    
    // Collect all center IDs and product IDs for batch reseller stock lookup
    const centerIds = stockRequests.map(req => req.center?._id).filter(Boolean);
    const allProductIds = [];
    
    stockRequests.forEach(request => {
      request.products.forEach(product => {
        if (product.product?._id) {
          allProductIds.push(product.product._id.toString());
        }
      });
    });
    
    // Get unique product IDs
    const uniqueProductIds = [...new Set(allProductIds)];
    
    if (centerIds.length > 0 && uniqueProductIds.length > 0) {
      // Get centers with their reseller information
      const centersWithResellers = await Center.find({
        _id: { $in: centerIds }
      }).populate('reseller', '_id businessName').select('_id reseller');
      
      // Create map of center ID to reseller ID
      centersWithResellers.forEach(center => {
        if (center.reseller) {
          centerToResellerMap.set(center._id.toString(), center.reseller._id);
        }
      });
      
      // Get all unique reseller IDs
      const uniqueResellerIds = [...new Set([...centerToResellerMap.values()])];
      
      if (uniqueResellerIds.length > 0) {
        // Fetch reseller stock data in bulk
        const ResellerStock = mongoose.model("ResellerStock");
        const resellerStocks = await ResellerStock.find({
          reseller: { $in: uniqueResellerIds },
          product: { $in: uniqueProductIds.map(id => new mongoose.Types.ObjectId(id)) }
        }).lean();
        
        // Create a map for quick lookup: key = "resellerId_productId"
        resellerStocks.forEach(stock => {
          const key = `${stock.reseller}_${stock.product}`;
          
          // Calculate damage repair and center return quantities from serials
          let damageRepairCount = 0;
          let centerReturnCount = 0;
          let availableSerials = [];
          
          if (stock.serialNumbers && stock.serialNumbers.length > 0) {
            // Count by source type from serial numbers
            const availableSerialsArray = stock.serialNumbers.filter(sn => 
              sn.status === "available"
            );
            
            availableSerials = availableSerialsArray.map(sn => sn.serialNumber);
            
            damageRepairCount = availableSerialsArray.filter(
              sn => sn.sourceType === "damage_repair"
            ).length;
            
            centerReturnCount = availableSerialsArray.filter(
              sn => sn.sourceType === "center_return"
            ).length;
          } else {
            // For non-serialized products, use sourceBreakdown
            damageRepairCount = stock.sourceBreakdown?.damageRepairQuantity || 0;
            centerReturnCount = stock.sourceBreakdown?.centerReturnQuantity || 0;
          }
          
          resellerStockMap.set(key, {
            totalQuantity: stock.totalQuantity || 0,
            availableQuantity: stock.availableQuantity || 0,
            consumedQuantity: stock.consumedQuantity || 0,
            damagedQuantity: stock.damagedQuantity || 0,
            repairQuantity: stock.repairQuantity || 0,
            sourceBreakdown: stock.sourceBreakdown || {
              damageRepairQuantity: damageRepairCount,
              centerReturnQuantity: centerReturnCount,
              directPurchaseQuantity: (stock.availableQuantity || 0) - damageRepairCount - centerReturnCount
            },
            availableSerials: availableSerials,
            availableSerialsCount: availableSerials.length,
            damageRepairSerialsCount: damageRepairCount,
            centerReturnSerialsCount: centerReturnCount
          });
        });
      }
    }

    // Define default reseller stock object at a higher scope so it can be reused
    const defaultResellerStock = {
      totalQuantity: 0,
      availableQuantity: 0,
      availableBreakdown: {
        damageRepair: 0,
        centerReturn: 0,
        directPurchase: 0,
        total: 0
      },
      sourceBreakdown: {
        damageRepairQuantity: 0,
        centerReturnQuantity: 0,
        directPurchaseQuantity: 0
      },
      availableSerials: [],
      availableSerialsCount: 0,
      damageRepairCount: 0,
      centerReturnCount: 0,
      hasResellerStock: false
    };

    const stockRequestsWithEnhancedData = stockRequests.map((request) => {
      const centerId = request.center?._id?.toString();
      const resellerId = centerId ? centerToResellerMap.get(centerId) : null;
      
      const productsWithEnhancedData = request.products.map((product) => {
        if (!product.product?._id || !request.center?._id) return product;

        const stockKey = `${request.center._id}_${product.product._id}`;
        const centerStockQuantity = stockMap.get(stockKey) || 0;
        
        // Get reseller stock data
        let resellerStockInfo = null;
        if (resellerId) {
          const resellerStockKey = `${resellerId}_${product.product._id}`;
          resellerStockInfo = resellerStockMap.get(resellerStockKey);
        }

        return {
          ...product,
          centerStockQuantity,
          resellerStock: resellerStockInfo ? {
            totalQuantity: resellerStockInfo.totalQuantity || 0,
            availableQuantity: resellerStockInfo.availableQuantity || 0,
            availableBreakdown: {
              damageRepair: resellerStockInfo.sourceBreakdown?.damageRepairQuantity || 0,
              centerReturn: resellerStockInfo.sourceBreakdown?.centerReturnQuantity || 0,
              directPurchase: resellerStockInfo.sourceBreakdown?.directPurchaseQuantity || 0,
              total: resellerStockInfo.availableQuantity || 0
            },
            sourceBreakdown: resellerStockInfo.sourceBreakdown || {
              damageRepairQuantity: 0,
              centerReturnQuantity: 0,
              directPurchaseQuantity: 0
            },
            availableSerials: resellerStockInfo.availableSerials || [],
            availableSerialsCount: resellerStockInfo.availableSerialsCount || 0,
            damageRepairCount: resellerStockInfo.damageRepairSerialsCount || 0,
            centerReturnCount: resellerStockInfo.centerReturnSerialsCount || 0,
            hasResellerStock: true
          } : defaultResellerStock
        };
      });

      // Calculate totals for the request with safe access
      const resellerStockTotals = productsWithEnhancedData.reduce((totals, product) => {
        const resellerStock = product.resellerStock || defaultResellerStock;
        const availableBreakdown = resellerStock.availableBreakdown || defaultResellerStock.availableBreakdown;
        
        totals.totalAvailable += resellerStock.availableQuantity || 0;
        totals.damageRepair += availableBreakdown.damageRepair || 0;
        totals.centerReturn += availableBreakdown.centerReturn || 0;
        totals.directPurchase += availableBreakdown.directPurchase || 0;
        return totals;
      }, {
        totalAvailable: 0,
        damageRepair: 0,
        centerReturn: 0,
        directPurchase: 0
      });

      return {
        ...request,
        products: productsWithEnhancedData,
        stockSummary: {
          centerStock: productsWithEnhancedData.reduce((sum, product) => 
            sum + (product.centerStockQuantity || 0), 0
          ),
          resellerStock: {
            totalAvailable: resellerStockTotals.totalAvailable,
            breakdown: {
              damageRepair: resellerStockTotals.damageRepair,
              centerReturn: resellerStockTotals.centerReturn,
              directPurchase: resellerStockTotals.directPurchase,
              percentage: {
                damageRepair: resellerStockTotals.totalAvailable > 0 ? 
                  Math.round((resellerStockTotals.damageRepair / resellerStockTotals.totalAvailable) * 100) : 0,
                centerReturn: resellerStockTotals.totalAvailable > 0 ? 
                  Math.round((resellerStockTotals.centerReturn / resellerStockTotals.totalAvailable) * 100) : 0,
                directPurchase: resellerStockTotals.totalAvailable > 0 ? 
                  Math.round((resellerStockTotals.directPurchase / resellerStockTotals.totalAvailable) * 100) : 0
              }
            }
          },
          resellerInfo: resellerId ? {
            hasReseller: true,
            resellerId: resellerId
          } : {
            hasReseller: false
          }
        }
      };
    });

    const statusStats = statusCounts.reduce((acc, stat) => {
      acc[stat._id] = stat.count;
      return acc;
    }, {});

    // Calculate overall statistics across all requests with safe access
    const overallStats = stockRequestsWithEnhancedData.reduce((stats, request) => {
      stats.totalRequests += 1;
      
      const stockSummary = request.stockSummary || { resellerStock: { totalAvailable: 0, breakdown: {} } };
      const resellerStock = stockSummary.resellerStock || { totalAvailable: 0, breakdown: {} };
      const breakdown = resellerStock.breakdown || {};
      
      stats.totalResellerAvailable += resellerStock.totalAvailable || 0;
      stats.totalDamageRepair += breakdown.damageRepair || 0;
      stats.totalCenterReturn += breakdown.centerReturn || 0;
      stats.totalDirectPurchase += breakdown.directPurchase || 0;
      
      if (stockSummary.resellerInfo?.hasReseller) {
        stats.requestsWithReseller += 1;
      }
      
      return stats;
    }, {
      totalRequests: 0,
      totalResellerAvailable: 0,
      totalDamageRepair: 0,
      totalCenterReturn: 0,
      totalDirectPurchase: 0,
      requestsWithReseller: 0
    });

    res.status(200).json({
      success: true,
      message: "Stock requests retrieved successfully",
      data: stockRequestsWithEnhancedData,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit),
      },
      filters: {
        status: statusStats,
        total: total,
      },
      summary: {
        overallResellerStock: {
          totalAvailable: overallStats.totalResellerAvailable,
          breakdown: {
            damageRepair: overallStats.totalDamageRepair,
            centerReturn: overallStats.totalCenterReturn,
            directPurchase: overallStats.totalDirectPurchase
          },
          percentage: {
            damageRepair: overallStats.totalResellerAvailable > 0 ? 
              Math.round((overallStats.totalDamageRepair / overallStats.totalResellerAvailable) * 100) : 0,
            centerReturn: overallStats.totalResellerAvailable > 0 ? 
              Math.round((overallStats.totalCenterReturn / overallStats.totalResellerAvailable) * 100) : 0,
            directPurchase: overallStats.totalResellerAvailable > 0 ? 
              Math.round((overallStats.totalDirectPurchase / overallStats.totalResellerAvailable) * 100) : 0
          }
        },
        requestsWithResellerStock: overallStats.requestsWithReseller,
        totalRequestsWithReseller: overallStats.totalRequests
      }
    });
  } catch (error) {
    console.error("Error retrieving stock requests:", error);
    res.status(500).json({
      success: false,
      message: "Error retrieving stock requests",
      error: error.message,
    });
  }
};

// export const getStockRequestById = async (req, res) => {
//   try {
//     const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
//       req,
//       ["indent_all_center", "indent_own_center"]
//     );

//     if (!hasAccess) {
//       return res.status(403).json({
//         success: false,
//         message:
//           "Access denied. indent_own_center or indent_all_center permission required.",
//       });
//     }

//     const { id } = req.params;

//     const stockRequest = await StockRequest.findById(id)
//       .populate("warehouse", "_id centerName centerCode centerType")
//       .populate({
//         path: "center",
//         select: "_id centerName centerCode centerType",
//         populate: [
//           {
//             path: "reseller",
//             select: "_id businessName contactNumber name mobile email gstNumber panNumber address1 address2 city state"
//           },
//           {
//             path: "area",
//             select: "_id areaName"
//           }
//         ]
//       })
//       .populate(
//         "products.product",
//         "_id productTitle productCode productImage trackSerialNumber"
//       )
//       .populate("createdBy", "_id fullName email")
//       .populate("updatedBy", "_id fullName email")
//       .populate("approvalInfo.approvedBy", "_id fullName email")
//       .populate("approvalInfo.warehouseChallanApprovedBy","_id fullName email" )
//       .populate("approvalInfo.centerChallanApprovedBy","_id fullName email" )
//       .populate("shippingInfo.shippedBy", "_id fullName email")
//       .populate("receivingInfo.receivedBy", "_id fullName email")
//       .populate("completionInfo.completedBy", "_id fullName email")
//       .populate("incompleteInfo.incompleteBy", "_id fullName email")
//       .populate("rejectionInfo.rejectedBy", "_id fullName email")
//       .lean();

//     if (!stockRequest) {
//       return res.status(404).json({
//         success: false,
//         message: "Stock request not found",
//       });
//     }

//     if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
//       return res.status(403).json({
//         success: false,
//         message:
//           "Access denied. You can only view stock requests from your own center.",
//       });
//     }

//     const productIds = stockRequest.products.map((p) => p.product._id);

//     const centerStock = await CenterStock.aggregate([
//       {
//         $match: {
//           center: stockRequest.center._id,
//           product: { $in: productIds },
//         },
//       },
//       {
//         $group: {
//           _id: "$product",
//           totalQuantity: { $sum: "$quantity" },
//         },
//       },
//     ]);

//     const centerStockMap = {};
//     centerStock.forEach((stock) => {
//       centerStockMap[stock._id.toString()] = stock.totalQuantity;
//     });

//     // Get outlet stock
//     const outletStockMap = await getOutletStockForRequests(
//       stockRequest.warehouse._id,
//       productIds
//     );

//     // NEW: Get reseller stock for the center's reseller
//     const ResellerStock = mongoose.model("ResellerStock");
//     const resellerId = stockRequest.center?.reseller?._id;
    
//     let resellerStockMap = new Map();
    
//     if (resellerId) {
//       // Get reseller stock for all products in the request
//       const resellerStocks = await ResellerStock.find({
//         reseller: resellerId,
//         product: { $in: productIds }
//       }).select("product availableQuantity totalQuantity consumedQuantity serialNumbers");
      
//       // Create a map for easy lookup
//       resellerStocks.forEach((stock) => {
//         const availableSerials = stock.serialNumbers
//           .filter(sn => sn.status === "available")
//           .map(sn => sn.serialNumber);
        
//         resellerStockMap.set(stock.product.toString(), {
//           totalQuantity: stock.totalQuantity,
//           availableQuantity: stock.availableQuantity,
//           consumedQuantity: stock.consumedQuantity,
//           damagedQuantity: stock.damagedQuantity,
//           repairQuantity: stock.repairQuantity,
//           hasSerialNumbers: stock.serialNumbers.length > 0,
//           availableSerials: availableSerials,
//           availableSerialsCount: availableSerials.length
//         });
//       });
//     }

//     const productsWithEnhancedData = stockRequest.products.map((product) => {
//       const outletStock = outletStockMap.get(product.product._id.toString()) || {
//         totalQuantity: 0,
//         availableQuantity: 0,
//         inTransitQuantity: 0,
//       };

//       const resellerStock = resellerStockMap.get(product.product._id.toString()) || {
//         totalQuantity: 0,
//         availableQuantity: 0,
//         consumedQuantity: 0,
//         damagedQuantity: 0,
//         repairQuantity: 0,
//         availableSerials: [],
//         availableSerialsCount: 0
//       };

//       return {
//         ...product,
//         centerStockQuantity: centerStockMap[product.product._id.toString()] || 0,
//         outletStock: {
//           totalQuantity: outletStock.totalQuantity,
//           availableQuantity: outletStock.availableQuantity,
//           inTransitQuantity: outletStock.inTransitQuantity,
//           hasSerialNumbers: outletStock.hasSerialNumbers,
//           availableSerials: outletStock.availableSerials || []
//         },
//         resellerStock: { // NEW: Added reseller stock information
//           totalQuantity: resellerStock.totalQuantity,
//           availableQuantity: resellerStock.availableQuantity,
//           consumedQuantity: resellerStock.consumedQuantity,
//           damagedQuantity: resellerStock.damagedQuantity,
//           repairQuantity: resellerStock.repairQuantity,
//           hasSerialNumbers: resellerStock.hasSerialNumbers,
//           availableSerials: resellerStock.availableSerials,
//           availableSerialsCount: resellerStock.availableSerialsCount
//         },
//         approvedSerials: product.approvedSerials || [],
//         serialNumbers: product.serialNumbers || [],
//         transferredSerials: product.transferredSerials || [],
//         serialSummary: {
//           approvedCount: product.approvedSerials?.length || 0,
//           transferredCount: product.transferredSerials?.length || 0,
//           requiresSerialNumbers: product.product.trackSerialNumber === "Yes",
//         },
//       };
//     });

//     // Calculate totals for summary
//     const totalResellerAvailable = productsWithEnhancedData.reduce(
//       (sum, product) => sum + product.resellerStock.availableQuantity, 0
//     );
    
//     const totalOutletAvailable = productsWithEnhancedData.reduce(
//       (sum, product) => sum + product.outletStock.availableQuantity, 0
//     );

//     const stockRequestWithEnhancedData = {
//       ...stockRequest,
//       products: productsWithEnhancedData,
//       stockSummary: { // NEW: Added overall stock summary
//         totalResellerAvailable,
//         totalOutletAvailable,
//         totalAvailable: totalResellerAvailable + totalOutletAvailable,
//         resellerName: stockRequest.center?.reseller?.businessName || "N/A",
//         resellerId: resellerId
//       }
//     };

//     res.status(200).json({
//       success: true,
//       message: "Stock request retrieved successfully",
//       data: stockRequestWithEnhancedData,
//     });
//   } catch (error) {
//     if (error.name === "CastError") {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid stock request ID",
//       });
//     }

//     console.error("Error retrieving stock request:", error);
//     res.status(500).json({
//       success: false,
//       message: "Error retrieving stock request",
//       error: error.message,
//     });
//   }
// };

export const getStockRequestById = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["indent_all_center", "indent_own_center"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. indent_own_center or indent_all_center permission required.",
      });
    }

    const { id } = req.params;

    const stockRequest = await StockRequest.findById(id)
      .populate("warehouse", "_id centerName centerCode centerType email addressLine1 addressLine2 city state")
      .populate({
        path: "center",
        select: "_id centerName centerCode centerType email addressLine1 addressLine2 city state",
        populate: [
          {
            path: "reseller",
            select: "_id businessName contactNumber name mobile email gstNumber panNumber address1 address2 city state"
          },
          {
            path: "area",
            select: "_id areaName"
          }
        ]
      })
      .populate(
        "products.product",
        "_id productTitle productCode salePrice trackSerialNumber"
      )
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email")
      .populate("approvalInfo.approvedBy", "_id fullName email")
      .populate("approvalInfo.warehouseChallanApprovedBy","_id fullName email" )
      .populate("approvalInfo.centerChallanApprovedBy","_id fullName email" )
      .populate("shippingInfo.shippedBy", "_id fullName email")
      .populate("receivingInfo.receivedBy", "_id fullName email")
      .populate("completionInfo.completedBy", "_id fullName email")
      .populate("incompleteInfo.incompleteBy", "_id fullName email") 
      .populate("rejectionInfo.rejectedBy", "_id fullName email")
      .lean();

    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only view stock requests from your own center.",
      });
    }

    const productIds = stockRequest.products.map((p) => p.product._id);

    // Get center stock from CenterStock collection
    const centerStock = await CenterStock.aggregate([
      {
        $match: {
          center: stockRequest.center._id,
          product: { $in: productIds },
        },
      },
      {
        $group: {
          _id: "$product",
          totalQuantity: { $sum: "$totalQuantity" },
          availableQuantity: { $sum: "$availableQuantity" },
          consumedQuantity: { $sum: "$consumedQuantity" },
          inTransitQuantity: { $sum: "$inTransitQuantity" },
        },
      },
    ]);

    const centerStockMap = {};
    centerStock.forEach((stock) => {
      centerStockMap[stock._id.toString()] = {
        totalQuantity: stock.totalQuantity,
        availableQuantity: stock.availableQuantity,
        consumedQuantity: stock.consumedQuantity,
        inTransitQuantity: stock.inTransitQuantity,
      };
    });

    // Get outlet stock
    const outletStockMap = await getOutletStockForRequests(
      stockRequest.warehouse._id,
      productIds
    );

    // Get reseller stock for the center's reseller
    const ResellerStock = mongoose.model("ResellerStock");
    const resellerId = stockRequest.center?.reseller?._id;
    
    let resellerStockMap = new Map();
    
    if (resellerId) {
      // Get reseller stock for all products in the request
      const resellerStocks = await ResellerStock.find({
        reseller: resellerId,
        product: { $in: productIds }
      }).select("product availableQuantity totalQuantity consumedQuantity serialNumbers");
      
      // Create a map for easy lookup
      resellerStocks.forEach((stock) => {
        const availableSerials = stock.serialNumbers
          .filter(sn => sn.status === "available")
          .map(sn => sn.serialNumber);
        
        resellerStockMap.set(stock.product.toString(), {
          totalQuantity: stock.totalQuantity,
          availableQuantity: stock.availableQuantity,
          consumedQuantity: stock.consumedQuantity,
          damagedQuantity: stock.damagedQuantity,
          repairQuantity: stock.repairQuantity,
          hasSerialNumbers: stock.serialNumbers.length > 0,
          availableSerials: availableSerials,
          availableSerialsCount: availableSerials.length
        });
      });
    }

    // Get serial numbers from CenterStock for each product
    const centerStockDetails = await CenterStock.find({
      center: stockRequest.center._id,
      product: { $in: productIds }
    }).select("product serialNumbers");

    const centerSerialNumbersMap = new Map();
    centerStockDetails.forEach(stock => {
      const availableSerials = stock.serialNumbers
        .filter(sn => sn.status === "available")
        .map(sn => sn.serialNumber);
      
      centerSerialNumbersMap.set(stock.product.toString(), {
        hasSerialNumbers: stock.serialNumbers.length > 0,
        availableSerials: availableSerials,
        availableSerialsCount: availableSerials.length,
        allSerials: stock.serialNumbers
      });
    });

    const productsWithEnhancedData = stockRequest.products.map((product) => {
      const productId = product.product._id.toString();
      const stockInfo = centerStockMap[productId] || {
        totalQuantity: 0,
        availableQuantity: 0,
        consumedQuantity: 0,
        inTransitQuantity: 0,
      };

      const outletStock = outletStockMap.get(productId) || {
        totalQuantity: 0,
        availableQuantity: 0,
        inTransitQuantity: 0,
      };

      const resellerStock = resellerStockMap.get(productId) || {
        totalQuantity: 0,
        availableQuantity: 0,
        consumedQuantity: 0,
        damagedQuantity: 0,
        repairQuantity: 0,
        availableSerials: [],
        availableSerialsCount: 0
      };

      const centerSerials = centerSerialNumbersMap.get(productId) || {
        hasSerialNumbers: false,
        availableSerials: [],
        availableSerialsCount: 0,
        allSerials: []
      };

      return {
        ...product,
        // Using availableQuantity from CenterStock
        centerStockQuantity: stockInfo.availableQuantity,
        centerStockDetails: stockInfo, // Added for more details
        outletStock: {
          totalQuantity: outletStock.totalQuantity,
          availableQuantity: outletStock.availableQuantity,
          inTransitQuantity: outletStock.inTransitQuantity,
          hasSerialNumbers: outletStock.hasSerialNumbers,
          availableSerials: outletStock.availableSerials || []
        },
        centerStockSerials: { // Added center stock serials info
          hasSerialNumbers: centerSerials.hasSerialNumbers,
          availableSerials: centerSerials.availableSerials,
          availableSerialsCount: centerSerials.availableSerialsCount,
          allSerials: centerSerials.allSerials
        },
        resellerStock: {
          totalQuantity: resellerStock.totalQuantity,
          availableQuantity: resellerStock.availableQuantity,
          consumedQuantity: resellerStock.consumedQuantity,
          damagedQuantity: resellerStock.damagedQuantity,
          repairQuantity: resellerStock.repairQuantity,
          hasSerialNumbers: resellerStock.hasSerialNumbers,
          availableSerials: resellerStock.availableSerials,
          availableSerialsCount: resellerStock.availableSerialsCount
        },
        approvedSerials: product.approvedSerials || [],
        serialNumbers: product.serialNumbers || [],
        transferredSerials: product.transferredSerials || [],
        serialSummary: {
          approvedCount: product.approvedSerials?.length || 0,
          transferredCount: product.transferredSerials?.length || 0,
          requiresSerialNumbers: product.product.trackSerialNumber === "Yes",
          centerAvailableSerials: centerSerials.availableSerialsCount,
          resellerAvailableSerials: resellerStock.availableSerialsCount
        },
      };
    });

    // Calculate totals for summary
    const totalCenterAvailable = productsWithEnhancedData.reduce(
      (sum, product) => sum + product.centerStockQuantity, 0
    );
    
    const totalResellerAvailable = productsWithEnhancedData.reduce(
      (sum, product) => sum + product.resellerStock.availableQuantity, 0
    );
    
    const totalOutletAvailable = productsWithEnhancedData.reduce(
      (sum, product) => sum + product.outletStock.availableQuantity, 0
    );

    const stockRequestWithEnhancedData = {
      ...stockRequest,
      products: productsWithEnhancedData,
      stockSummary: {
        totalCenterAvailable,
        totalResellerAvailable,
        totalOutletAvailable,
        totalAvailable: totalCenterAvailable + totalResellerAvailable + totalOutletAvailable,
        resellerName: stockRequest.center?.reseller?.businessName || "N/A",
        resellerId: resellerId,
        centerName: stockRequest.center?.centerName || "N/A"
      }
    };

    res.status(200).json({
      success: true,
      message: "Stock request retrieved successfully",
      data: stockRequestWithEnhancedData,
    });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid stock request ID",
      });
    }

    console.error("Error retrieving stock request:", error);
    res.status(500).json({
      success: false,
      message: "Error retrieving stock request",
      error: error.message,
    });
  }
};

export const updateStockRequest = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["manage_indent"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. manage_indent permission required.",
      });
    }

    const { id } = req.params;
    const {
      warehouse,
      center,
      remark,
      products,
      status,
      approvalInfo,
      shippingInfo,
      receivingInfo,
      completionInfo,
      orderNumber,
      rejectionReason, 
    } = req.body;

    const existingRequest = await StockRequest.findById(id);
    if (!existingRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (!checkCenterAccess(existingRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only manage stock requests from your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const updateData = {
      updatedBy: userId,
      ...(warehouse && { warehouse }),
      ...(center && { center }),
      ...(remark !== undefined && { remark }),
      ...(status && { status }),
      ...(orderNumber && { orderNumber: orderNumber.trim() }),
      ...(approvalInfo && {
        approvalInfo: { ...existingRequest.approvalInfo, ...approvalInfo },
      }),
      ...(shippingInfo && {
        shippingInfo: { ...existingRequest.shippingInfo, ...shippingInfo },
      }),
      ...(receivingInfo && {
        receivingInfo: { ...existingRequest.receivingInfo, ...receivingInfo },
      }),
      ...(completionInfo && {
        completionInfo: {
          ...existingRequest.completionInfo,
          ...completionInfo,
        },
      }),
    };

    if (status === "Rejected" && existingRequest.status !== "Rejected") {
      if (!rejectionReason || rejectionReason.trim() === '') {
        return res.status(400).json({
          success: false,
          message: "Rejection reason is required when rejecting a stock request",
        });
      }

      await revertStockForRejectedRequest(existingRequest);
      updateData.rejectionInfo = {
        rejectedAt: new Date(),
        rejectedBy: userId,
        rejectionReason: rejectionReason.trim(),
      };
    }

    if (products) {
      if (["Draft", "Submitted"].includes(existingRequest.status)) {
        updateData.products = products;
      } else {
        updateData.products = existingRequest.products.map(
          (existingProduct, index) => {
            const newProduct = products.find(
              (p) => p.product.toString() === existingProduct.product.toString()
            );
            if (newProduct) {
              return {
                ...existingProduct.toObject(),
                quantity:
                  newProduct.quantity !== undefined
                    ? newProduct.quantity
                    : existingProduct.quantity,
                productRemark:
                  newProduct.productRemark !== undefined
                    ? newProduct.productRemark
                    : existingProduct.productRemark,
                receivedQuantity:
                  newProduct.receivedQuantity !== undefined
                    ? newProduct.receivedQuantity
                    : existingProduct.receivedQuantity,
                receivedRemark:
                  newProduct.receivedRemark !== undefined
                    ? newProduct.receivedRemark
                    : existingProduct.receivedRemark,

                approvedSerials:
                  newProduct.approvedSerials !== undefined
                    ? newProduct.approvedSerials
                    : existingProduct.approvedSerials,
              };
            }
            return existingProduct;
          }
        );
      }
    }

    if (status) {
      const currentDate = new Date();

      switch (status) {
        case "Confirmed":
          updateData.approvalInfo = {
            ...existingRequest.approvalInfo,
            approvedAt: currentDate,
            approvedBy: userId,
            ...approvalInfo,
          };
          break;
        case "Shipped":
          updateData.shippingInfo = {
            ...existingRequest.shippingInfo,
            shippedAt: currentDate,
            shippedBy: userId,
            ...shippingInfo,
          };
          break;
        case "Completed":
          updateData.receivingInfo = {
            ...existingRequest.receivingInfo,
            receivedAt: currentDate,
            receivedBy: userId,
            ...receivingInfo,
          };
          updateData.completionInfo = {
            ...existingRequest.completionInfo,
            completedOn: currentDate,
            completedBy: userId,
            ...completionInfo,
          };
          break;
        case "Incompleted":
          updateData.completionInfo = {
            ...existingRequest.completionInfo,
            incompleteOn: currentDate,
            incompleteBy: userId,
            incompleteRemark: completionInfo?.incompleteRemark || "",
            ...completionInfo,
          };
          break;
        case "Rejected":
          
          // updateData.completionInfo = {
          //   ...existingRequest.completionInfo,
          //   incompleteOn: currentDate,
          //   incompleteBy: userId,
          //   ...completionInfo,
          // };
          break;
      }
    }

    const updatedRequest = await StockRequest.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode centerType")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email")
      .populate("approvalInfo.approvedBy", "_id fullName email")
      .populate("shippingInfo.shippedBy", "_id fullName email")
      .populate("receivingInfo.receivedBy", "_id fullName email")
      .populate("incompleteInfo.incompleteBy", "_id fullName email")
      .populate("rejectionInfo.rejectedBy", "_id fullName email"); 
    res.status(200).json({
      success: true,
      message: "Stock request updated successfully",
      data: updatedRequest,
    });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid stock request ID",
      });
    }

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message:
          "Order number already exists. Please use a different order number.",
      });
    }

    console.error("Error updating stock request:", error);
    res.status(500).json({
      success: false,
      message: "Error updating stock request",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

// async function revertStockForRejectedRequest(stockRequest) {
//   try {
//     const OutletStock = mongoose.model("OutletStock");
//     const CenterStock = mongoose.model("CenterStock");

//     for (const productItem of stockRequest.products) {
//       if (
//         productItem.approvedSerials &&
//         productItem.approvedSerials.length > 0
//       ) {
//         const outletStock = await OutletStock.findOne({
//           outlet: stockRequest.warehouse,
//           product: productItem.product,
//         });

//         if (outletStock) {
//           let revertedCount = 0;

//           for (const serialNumber of productItem.approvedSerials) {
//             const serial = outletStock.serialNumbers.find(
//               (sn) => sn.serialNumber === serialNumber
//             );

//             if (serial) {
//               if (serial.status === "in_transit") {
//                 serial.status = "available";
//                 serial.currentLocation = stockRequest.warehouse;

//                 if (serial.transferHistory.length > 0) {
//                   const lastTransfer =
//                     serial.transferHistory[serial.transferHistory.length - 1];
//                   if (lastTransfer.status === "in_transit") {
//                     serial.transferHistory.pop();
//                   }
//                 }

//                 revertedCount++;
//                 console.log(
//                   `Reverted serial ${serialNumber} back to available status due to request rejection`
//                 );
//               } else if (serial.status === "transferred") {
//                 serial.status = "available";
//                 serial.currentLocation = stockRequest.warehouse;

//                 serial.transferHistory = serial.transferHistory.filter(
//                   (transfer) =>
//                     transfer.toCenter?.toString() !==
//                     stockRequest.center.toString()
//                 );

//                 revertedCount++;
//                 console.log(
//                   `Reverted transferred serial ${serialNumber} back to available status due to request rejection`
//                 );
//               }
//             }
//           }

//           if (revertedCount > 0) {
//             outletStock.availableQuantity += revertedCount;

//             const inTransitSerials = productItem.approvedSerials.filter(
//               (serialNumber) => {
//                 const serial = outletStock.serialNumbers.find(
//                   (sn) => sn.serialNumber === serialNumber
//                 );
//                 return serial && serial.status === "in_transit";
//               }
//             );

//             outletStock.inTransitQuantity -= inTransitSerials.length;

//             const transferredSerials = productItem.approvedSerials.filter(
//               (serialNumber) => {
//                 const serial = outletStock.serialNumbers.find(
//                   (sn) => sn.serialNumber === serialNumber
//                 );
//                 return serial && serial.status === "transferred";
//               }
//             );

//             outletStock.totalQuantity += transferredSerials.length;

//             await outletStock.save();
//             console.log(
//               `Reverted ${revertedCount} items back to available for product ${productItem.product} due to request rejection`
//             );

//             if (transferredSerials.length > 0) {
//               const centerStock = await CenterStock.findOne({
//                 center: stockRequest.center,
//                 product: productItem.product,
//               });

//               if (centerStock) {
//                 centerStock.serialNumbers = centerStock.serialNumbers.filter(
//                   (sn) => !transferredSerials.includes(sn.serialNumber)
//                 );

//                 centerStock.totalQuantity -= transferredSerials.length;
//                 centerStock.availableQuantity -= transferredSerials.length;

//                 await centerStock.save();
//                 console.log(
//                   `Removed ${transferredSerials.length} items from center stock for product ${productItem.product} due to request rejection`
//                 );
//               }
//             }
//           }
//         }
//       }
//     }

//     stockRequest.products = stockRequest.products.map((productItem) => ({
//       ...productItem.toObject(),
//       approvedQuantity: 0,
//       approvedSerials: [],
//       transferredSerials: [],
//       receivedQuantity: 0,
//       receivedRemark: "",
//     }));

//     await stockRequest.save();
//   } catch (error) {
//     console.error("Error reverting stock for rejected request:", error);
//     throw new Error(`Failed to revert stock: ${error.message}`);
//   }
// }

async function revertStockForRejectedRequest(stockRequest) {
  try {
    const OutletStock = mongoose.model("OutletStock");
    const CenterStock = mongoose.model("CenterStock");

    for (const productItem of stockRequest.products) {
      const outletStock = await OutletStock.findOne({
        outlet: stockRequest.warehouse,
        product: productItem.product,
      });

      if (!outletStock) {
        console.log(`No outlet stock found for product ${productItem.product}`);
        continue;
      }

      console.log(`\n========== Processing product ${productItem.product} ==========`);
      console.log(`BEFORE - Total: ${outletStock.totalQuantity}, Available: ${outletStock.availableQuantity}, InTransit: ${outletStock.inTransitQuantity}`);
      console.log(`Product approved quantity: ${productItem.approvedQuantity || 0}`);
      console.log(`Has approvedSerials: ${productItem.approvedSerials?.length || 0} serials`);

      // ============================================================
      // HANDLE SERIALIZED PRODUCTS
      // ============================================================
      if (productItem.approvedSerials && productItem.approvedSerials.length > 0) {
        let revertedCount = 0;
        let transferredSerials = [];
        let inTransitSerialsCount = 0;

        for (const serialNumber of productItem.approvedSerials) {
          const serial = outletStock.serialNumbers.find(
            (sn) => sn.serialNumber === serialNumber
          );

          if (serial) {
            if (serial.status === "in_transit") {
              serial.status = "available";
              serial.currentLocation = stockRequest.warehouse;
              inTransitSerialsCount++;

              if (serial.transferHistory.length > 0) {
                const lastTransfer = serial.transferHistory[serial.transferHistory.length - 1];
                if (lastTransfer && lastTransfer.status === "in_transit") {
                  serial.transferHistory.pop();
                }
              }

              revertedCount++;
              console.log(`✅ Reverted serial ${serialNumber} from IN_TRANSIT to AVAILABLE`);
            } 
            else if (serial.status === "transferred") {
              serial.status = "available";
              serial.currentLocation = stockRequest.warehouse;

              serial.transferHistory = serial.transferHistory.filter(
                (transfer) =>
                  transfer.toCenter?.toString() !== stockRequest.center.toString()
              );

              transferredSerials.push(serialNumber);
              revertedCount++;
              console.log(`✅ Reverted serial ${serialNumber} from TRANSFERRED to AVAILABLE`);
            }
            else if (serial.status === "available") {
              console.log(`⚠️ Serial ${serialNumber} is already AVAILABLE, no change needed`);
            }
          } else {
            console.log(`⚠️ Serial ${serialNumber} not found in outlet stock`);
          }
        }

        if (revertedCount > 0) {
          // Update outlet stock quantities with safety checks
          outletStock.availableQuantity += revertedCount;
          
          // ✅ SAFETY CHECK: Don't subtract more than available
          const inTransitToSubtract = Math.min(inTransitSerialsCount, outletStock.inTransitQuantity);
          outletStock.inTransitQuantity -= inTransitToSubtract;
          
          if (inTransitSerialsCount > inTransitToSubtract) {
            console.log(`⚠️ Tried to subtract ${inTransitSerialsCount} from inTransit but only ${inTransitToSubtract} was available`);
          }

          if (transferredSerials.length > 0) {
            outletStock.totalQuantity += transferredSerials.length;
            
            const centerStock = await CenterStock.findOne({
              center: stockRequest.center,
              product: productItem.product,
            });

            if (centerStock) {
              // ✅ SAFETY CHECK: Don't remove more than available
              const serialsToRemove = transferredSerials.filter(serial => 
                centerStock.serialNumbers.some(sn => sn.serialNumber === serial)
              );
              
              centerStock.serialNumbers = centerStock.serialNumbers.filter(
                (sn) => !transferredSerials.includes(sn.serialNumber)
              );

              const removeCount = serialsToRemove.length;
              centerStock.totalQuantity = Math.max(0, centerStock.totalQuantity - removeCount);
              centerStock.availableQuantity = Math.max(0, centerStock.availableQuantity - removeCount);

              await centerStock.save();
              console.log(`✅ Removed ${removeCount} items from center stock`);
            }
          }

          // ✅ FINAL SAFETY CHECK: Ensure no negative values
          if (outletStock.inTransitQuantity < 0) {
            console.log(`⚠️ inTransitQuantity was ${outletStock.inTransitQuantity}, resetting to 0`);
            outletStock.inTransitQuantity = 0;
          }
          if (outletStock.availableQuantity < 0) {
            console.log(`⚠️ availableQuantity was ${outletStock.availableQuantity}, resetting to 0`);
            outletStock.availableQuantity = 0;
          }
          if (outletStock.totalQuantity < 0) {
            console.log(`⚠️ totalQuantity was ${outletStock.totalQuantity}, resetting to 0`);
            outletStock.totalQuantity = 0;
          }

          await outletStock.save();
          console.log(`✅ Reverted ${revertedCount} serialized items for product ${productItem.product}`);
        }
      } 
      // ============================================================
      // HANDLE NON-SERIALIZED PRODUCTS
      // ============================================================
      else if (productItem.approvedQuantity && productItem.approvedQuantity > 0) {
        console.log(`\n📦 Handling NON-SERIALIZED product`);
        console.log(`Approved quantity to revert: ${productItem.approvedQuantity}`);
        
        let currentInTransit = outletStock.inTransitQuantity || 0;
        let currentAvailable = outletStock.availableQuantity || 0;
        let currentTotal = outletStock.totalQuantity || 0;
        
        console.log(`Current - InTransit: ${currentInTransit}, Available: ${currentAvailable}, Total: ${currentTotal}`);
        
        const quantityToRevert = productItem.approvedQuantity;
        let revertedFromInTransit = 0;
        let revertedFromCenter = 0;
        
        // ✅ STEP 1: Revert from in_transit stock first
        if (currentInTransit > 0) {
          revertedFromInTransit = Math.min(quantityToRevert, currentInTransit);
          outletStock.inTransitQuantity -= revertedFromInTransit;
          outletStock.availableQuantity += revertedFromInTransit;
          console.log(`✅ Reverted ${revertedFromInTransit} units from IN_TRANSIT to AVAILABLE`);
        }
        
        let remainingToRevert = quantityToRevert - revertedFromInTransit;
        
        // ✅ STEP 2: If still remaining, check if it was transferred to center
        if (remainingToRevert > 0) {
          const centerStock = await CenterStock.findOne({
            center: stockRequest.center,
            product: productItem.product,
          });

          if (centerStock) {
            const centerAvailable = centerStock.availableQuantity || 0;
            const centerTotal = centerStock.totalQuantity || 0;
            
            console.log(`Center stock - Available: ${centerAvailable}, Total: ${centerTotal}`);
            
            if (centerAvailable > 0) {
              revertedFromCenter = Math.min(remainingToRevert, centerAvailable);
              
              // Remove from center stock
              centerStock.availableQuantity = Math.max(0, centerStock.availableQuantity - revertedFromCenter);
              centerStock.totalQuantity = Math.max(0, centerStock.totalQuantity - revertedFromCenter);
              
              // Add back to outlet total (but not available, since it was already consumed/transferred)
              outletStock.totalQuantity += revertedFromCenter;
              
              await centerStock.save();
              console.log(`✅ Removed ${revertedFromCenter} units from CENTER stock`);
              
              remainingToRevert -= revertedFromCenter;
            }
          }
        }
        
        // ✅ STEP 3: If still remaining, log warning
        if (remainingToRevert > 0) {
          console.log(`⚠️ WARNING: ${remainingToRevert} units could not be reverted (not found in in_transit or center stock)`);
        }
        
        // ✅ FINAL SAFETY CHECK: Ensure no negative values
        if (outletStock.inTransitQuantity < 0) {
          console.log(`⚠️ inTransitQuantity was ${outletStock.inTransitQuantity}, resetting to 0`);
          outletStock.inTransitQuantity = 0;
        }
        if (outletStock.availableQuantity < 0) {
          console.log(`⚠️ availableQuantity was ${outletStock.availableQuantity}, resetting to 0`);
          outletStock.availableQuantity = 0;
        }
        if (outletStock.totalQuantity < 0) {
          console.log(`⚠️ totalQuantity was ${outletStock.totalQuantity}, resetting to 0`);
          outletStock.totalQuantity = 0;
        }
        
        await outletStock.save();
        
        console.log(`AFTER - Total: ${outletStock.totalQuantity}, Available: ${outletStock.availableQuantity}, InTransit: ${outletStock.inTransitQuantity}`);
        console.log(`✅ Reverted summary: ${revertedFromInTransit} from in_transit, ${revertedFromCenter} from center`);
      }
      
      // Reset product item quantities
      productItem.approvedQuantity = 0;
      productItem.approvedSerials = [];
      productItem.transferredSerials = [];
      productItem.receivedQuantity = 0;
      productItem.receivedRemark = "";
    }

    await stockRequest.save();
    console.log("\n✅ Successfully reverted stock for rejected request\n");
    
  } catch (error) {
    console.error("❌ Error reverting stock for rejected request:", error);
    throw new Error(`Failed to revert stock: ${error.message}`);
  }
}

export const deleteStockRequest = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["delete_indent_all_center", "delete_indent_own_center"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. delete_indent_own_center or delete_indent_all_center permission required.",
      });
    }

    const { id } = req.params;

    const stockRequest = await StockRequest.findById(id);

    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (
      permissions.delete_indent_own_center &&
      !permissions.delete_indent_all_center &&
      userCenter
    ) {
      const userCenterId = userCenter._id || userCenter;
      const requestCenterId = stockRequest.center._id || stockRequest.center;
      if (userCenterId.toString() !== requestCenterId.toString()) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied. You can only delete stock requests from your own center.",
        });
      }
    }

    if (
      !["Submitted", "Incompleted", "Draft", "Completed", "Confirmed"].includes(
        stockRequest.status
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Only Submitted, Incompleted, Draft, Confirmed and Completed stock requests can be deleted",
      });
    }

    await StockRequest.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: "Stock request deleted successfully",
    });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid stock request ID",
      });
    }

    console.error("Error deleting stock request:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting stock request",
      error: error.message,
    });
  }
};

export const validateSerialNumbers = async (req, res) => {
  try {
    const { id } = req.params;
    const { productApprovals } = req.body;

    const stockRequest = await StockRequest.findById(id);
    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    const validationResults = await stockRequest.validateSerialNumbers(
      productApprovals
    );

    const hasErrors = validationResults.some((result) => !result.valid);

    res.status(200).json({
      success: true,
      message: hasErrors
        ? "Some serial numbers validation failed"
        : "All serial numbers are valid",
      data: validationResults,
      isValid: !hasErrors,
    });
  } catch (error) {
    console.error("Error validating serial numbers:", error);
    res.status(500).json({
      success: false,
      message: "Error validating serial numbers",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

// export const approveStockRequest = async (req, res) => {
//   try {
//     const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
//       req,
//       ["stock_transfer_approve_from_outlet", "manage_indent"]
//     );

//     if (!hasAccess) {
//       return res.status(403).json({
//         success: false,
//         message:
//           "Access denied. stock_transfer_approve_from_outlet or manage_indent permission required.",
//       });
//     }

//     const { id } = req.params;
//     const { productApprovals } = req.body;

//     const stockRequest = await StockRequest.findById(id)
//       .populate("center", "reseller centerType centerName centerCode")
//       .populate("warehouse", "centerType centerName centerCode");
    
//     if (!stockRequest) {
//       return res.status(404).json({
//         success: false,
//         message: "Stock request not found",
//       });
//     }

//     if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
//       return res.status(403).json({
//         success: false,
//         message:
//           "Access denied. You can only approve stock requests from your own center.",
//       });
//     }

//     const userId = req.user?.id;
//     if (!userId) {
//       return res.status(400).json({
//         success: false,
//         message: "User authentication required",
//       });
//     }

//     // Get reseller ID from the center making the request
//     // IMPORTANT: Check if center has reseller populated
//     const resellerId = stockRequest.center?.reseller?._id || stockRequest.center?.reseller;
    
//     // Check center type - only "Center" type should have reseller
//     const centerType = stockRequest.center?.centerType;
    
//     if (centerType === "Center" && !resellerId) {
//       return res.status(400).json({
//         success: false,
//         message: `Center "${stockRequest.center?.centerName || stockRequest.center}" is of type "Center" but does not have an associated reseller. Please update the center information.`,
//         centerId: stockRequest.center?._id,
//         centerName: stockRequest.center?.centerName,
//       });
//     }

//     const ResellerStock = mongoose.model("ResellerStock");
//     const OutletStock = mongoose.model("OutletStock");
//     const Product = mongoose.model("Product");

//     // Validate product approvals and check stock availability
//     if (productApprovals && productApprovals.length > 0) {
//       for (const approval of productApprovals) {
//         const productItem = stockRequest.products.find(
//           (p) => p.product.toString() === approval.productId.toString()
//         );

//         if (!productItem) {
//           return res.status(400).json({
//             success: false,
//             message: `Product ${approval.productId} not found in stock request`,
//           });
//         }

//         // Validate approved quantity
//         if (
//           approval.approvedQuantity === undefined ||
//           approval.approvedQuantity === null
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity is required for product ${productItem.product}`,
//           });
//         }

//         if (
//           typeof approval.approvedQuantity !== "number" ||
//           isNaN(approval.approvedQuantity)
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity must be a valid number for product ${productItem.product}`,
//           });
//         }

//         if (approval.approvedQuantity < 0) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity cannot be negative for product ${productItem.product}`,
//           });
//         }

//         if (approval.approvedQuantity > productItem.quantity) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity (${approval.approvedQuantity}) cannot exceed requested quantity (${productItem.quantity}) for product ${productItem.product}`,
//           });
//         }

//         if (
//           approval.approvedQuantity === 0 &&
//           (!approval.approvedRemark || approval.approvedRemark.trim() === "")
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Approval remark is required when approved quantity is zero for product ${productItem.product}`,
//           });
//         }

//         // Check stock availability - MODIFIED to handle case when no reseller
//         if (approval.approvedQuantity > 0) {
//           const productDoc = await Product.findById(approval.productId);
//           const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";

//           let totalAvailable = 0;
//           let resellerAvailable = 0;
//           let outletAvailable = 0;
//           let hasResellerStock = false;
          
//           // Only check reseller stock if center has a reseller
//           if (resellerId) {
//             const resellerStock = await ResellerStock.findOne({
//               reseller: resellerId,
//               product: approval.productId,
//             });

//             if (resellerStock) {
//               resellerAvailable = resellerStock.availableQuantity || 0;
//               hasResellerStock = true;
//             }
//           }

//           // Always check outlet stock
//           const outletStock = await OutletStock.findOne({
//             outlet: stockRequest.warehouse,
//             product: approval.productId,
//           });

//           if (outletStock) {
//             outletAvailable = outletStock.availableQuantity || 0;
//           }
          
//           totalAvailable = resellerAvailable + outletAvailable;

//           if (totalAvailable < approval.approvedQuantity) {
//             let message = `Insufficient total stock for product ${productDoc?.productTitle || approval.productId}. `;
//             message += `Available: ${totalAvailable}`;
            
//             if (hasResellerStock) {
//               message += ` (Reseller: ${resellerAvailable}, Outlet: ${outletAvailable})`;
//             } else {
//               message += ` (Outlet: ${outletAvailable})`;
//             }
            
//             message += `, Requested: ${approval.approvedQuantity}`;
            
//             return res.status(400).json({
//               success: false,
//               message,
//               availableQuantity: totalAvailable,
//               resellerAvailable,
//               outletAvailable,
//               requestedQuantity: approval.approvedQuantity,
//             });
//           }

//           if (tracksSerialNumbers) {
//             if (!approval.approvedSerials || approval.approvedSerials.length === 0) {
//               return res.status(400).json({
//                 success: false,
//                 message: `Serial numbers are required for product ${productDoc.productTitle} as it tracks serial numbers`,
//               });
//             }

//             if (approval.approvedSerials.length !== approval.approvedQuantity) {
//               return res.status(400).json({
//                 success: false,
//                 message: `Number of serial numbers (${approval.approvedSerials.length}) must match approved quantity (${approval.approvedQuantity}) for product ${productDoc.productTitle}`,
//               });
//             }

//             // Check serial numbers - MODIFIED to handle case when no reseller
//             const availableSerials = [];
//             const unavailableSerials = [];
            
//             let resellerSerialsFound = 0;
            
//             // First check reseller stock for serials (if center has reseller)
//             if (resellerId && hasResellerStock) {
//               const resellerStock = await ResellerStock.findOne({
//                 reseller: resellerId,
//                 product: approval.productId,
//               });
              
//               if (resellerStock) {
//                 for (const serialNumber of approval.approvedSerials) {
//                   const serial = resellerStock.serialNumbers.find(
//                     sn => sn.serialNumber === serialNumber && sn.status === "available"
//                   );
//                   if (serial) {
//                     availableSerials.push(serialNumber);
//                     resellerSerialsFound++;
//                   } else {
//                     unavailableSerials.push(serialNumber);
//                   }
//                 }
//               }
//             } else {
//               // If no reseller, all serials need to be checked in outlet
//               unavailableSerials.push(...approval.approvedSerials);
//             }
            
//             // Then check outlet stock for remaining serials
//             if (unavailableSerials.length > 0 && outletStock) {
//               const remainingSerials = [...unavailableSerials];
//               unavailableSerials.length = 0; // Clear array
              
//               for (const serialNumber of remainingSerials) {
//                 const serial = outletStock.serialNumbers.find(
//                   sn => sn.serialNumber === serialNumber && sn.status === "available"
//                 );
//                 if (serial) {
//                   availableSerials.push(serialNumber);
//                 } else {
//                   unavailableSerials.push(serialNumber);
//                 }
//               }
//             }
            
//             if (unavailableSerials.length > 0) {
//               let errorMessage = `Some serial numbers are not available`;
              
//               if (hasResellerStock) {
//                 errorMessage += ` in reseller or outlet stock`;
//               } else {
//                 errorMessage += ` in outlet stock`;
//               }
              
//               errorMessage += ` for product ${productDoc.productTitle}: ${unavailableSerials.join(", ")}`;
              
//               return res.status(400).json({
//                 success: false,
//                 message: errorMessage,
//                 unavailableSerials,
//                 resellerAvailable,
//                 outletAvailable,
//                 totalAvailable: totalAvailable,
//               });
//             }
            
//             // Store source details
//             approval._sourceDetails = {
//               fromReseller: approval.approvedSerials.slice(0, resellerSerialsFound),
//               fromOutlet: approval.approvedSerials.slice(resellerSerialsFound),
//               resellerCount: resellerSerialsFound,
//               outletCount: approval.approvedSerials.length - resellerSerialsFound,
//               hasReseller: hasResellerStock
//             };
//           } else {
//             if (approval.approvedSerials && approval.approvedSerials.length > 0) {
//               return res.status(400).json({
//                 success: false,
//                 message: `Serial numbers should not be provided for product ${productDoc.productTitle} as it does not track serial numbers`,
//               });
//             }
            
//             // Store quantity distribution
//             const resellerQty = hasResellerStock ? Math.min(resellerAvailable, approval.approvedQuantity) : 0;
//             const outletQty = approval.approvedQuantity - resellerQty;
            
//             approval._sourceDetails = {
//               fromReseller: resellerQty,
//               fromOutlet: outletQty,
//               resellerCount: resellerQty,
//               outletCount: outletQty,
//               hasReseller: hasResellerStock
//             };
//           }
//         } else {
//           const productDoc = await Product.findById(approval.productId);
//           if (approval.approvedSerials && approval.approvedSerials.length > 0) {
//             return res.status(400).json({
//               success: false,
//               message: `Serial numbers should not be provided when approved quantity is zero for product ${productDoc.productTitle}`,
//             });
//           }
//         }
//       }

//       const productApprovalsWithQuantity = productApprovals.filter(
//         (pa) => pa.approvedQuantity > 0
//       );

//       if (productApprovalsWithQuantity.length > 0) {
//         const validationResults = await stockRequest.validateSerialNumbers(
//           productApprovalsWithQuantity
//         );
//         const invalidResults = validationResults.filter(
//           (result) => !result.valid
//         );

//         if (invalidResults.length > 0) {
//           return res.status(400).json({
//             success: false,
//             message: "Serial number validation failed",
//             validationErrors: invalidResults.map((result) => ({
//               productId: result.productId,
//               productName: result.productName,
//               error: result.error,
//             })),
//           });
//         }
//       }
//     }

//     // Update stockRequest products with source breakdown
//     const updatedProducts = stockRequest.products.map(productItem => {
//       const approval = productApprovals.find(
//         pa => pa.productId.toString() === productItem.product.toString()
//       );
      
//       if (approval && approval._sourceDetails) {
//         const sourceDetails = approval._sourceDetails;
        
//         const sourceBreakdown = {
//           fromReseller: {
//             quantity: sourceDetails.resellerCount,
//             serials: sourceDetails.fromReseller instanceof Array ? 
//               sourceDetails.fromReseller : []
//           },
//           fromOutlet: {
//             quantity: sourceDetails.outletCount,
//             serials: sourceDetails.fromOutlet instanceof Array ? 
//               sourceDetails.fromOutlet : []
//           },
//           totalApproved: approval.approvedQuantity,
//           hasReseller: sourceDetails.hasReseller
//         };
        
//         return {
//           ...productItem.toObject(),
//           approvedQuantity: approval.approvedQuantity,
//           approvedRemark: approval.approvedRemark || "",
//           approvedSerials: approval.approvedSerials || [],
//           sourceBreakdown: sourceBreakdown
//         };
//       }
//       return productItem;
//     });

//     stockRequest.products = updatedProducts;
//     await stockRequest.save();

//     // Process stock allocation
//     if (productApprovals && productApprovals.length > 0) {
//       for (const approval of productApprovals) {
//         if (approval.approvedQuantity > 0) {
//           const sourceDetails = approval._sourceDetails;
          
//           // Process from reseller stock (if available)
//           if (sourceDetails.resellerCount > 0 && sourceDetails.hasReseller) {
//             const resellerStock = await ResellerStock.findOne({
//               reseller: resellerId,
//               product: approval.productId,
//             });

//             if (resellerStock) {
//               if (sourceDetails.fromReseller instanceof Array) {
//                 // Serialized products from reseller
//                 for (const serialNumber of sourceDetails.fromReseller) {
//                   const serial = resellerStock.serialNumbers.find(
//                     (sn) => sn.serialNumber === serialNumber
//                   );

//                   if (serial && serial.status === "available") {
//                     serial.status = "consumed";
//                     serial.currentLocation = stockRequest.center;
//                     serial.consumedDate = new Date();
//                     serial.consumedBy = userId;

//                     serial.transferHistory.push({
//                       fromCenter: null,
//                       toCenter: stockRequest.center,
//                       transferDate: new Date(),
//                       transferType: "outbound_transfer",
//                       remark: "Stock request approval",
//                       transferredBy: userId,
//                       referenceId: stockRequest._id
//                     });
//                   }
//                 }

//                 resellerStock.availableQuantity -= sourceDetails.resellerCount;
//                 resellerStock.consumedQuantity += sourceDetails.resellerCount;
                
//                 console.log(`Deducted ${sourceDetails.resellerCount} serials from reseller stock`);
//               } else {
//                 // Non-serialized products from reseller
//                 resellerStock.availableQuantity -= sourceDetails.resellerCount;
//                 resellerStock.consumedQuantity += sourceDetails.resellerCount;
                
//                 console.log(`Deducted ${sourceDetails.resellerCount} units from reseller stock (non-serialized)`);
//               }

//               await resellerStock.save();
//             }
//           }

//           // Process from outlet stock
//           if (sourceDetails.outletCount > 0) {
//             const outletStock = await OutletStock.findOne({
//               outlet: stockRequest.warehouse,
//               product: approval.productId,
//             });

//             if (outletStock) {
//               if (sourceDetails.fromOutlet instanceof Array) {
//                 // Serialized products from outlet
//                 for (const serialNumber of sourceDetails.fromOutlet) {
//                   const serial = outletStock.serialNumbers.find(
//                     (sn) => sn.serialNumber === serialNumber
//                   );

//                   if (serial && serial.status === "available") {
//                     serial.status = "in_transit";
//                     serial.currentLocation = stockRequest.warehouse;

//                     serial.transferHistory.push({
//                       fromCenter: stockRequest.warehouse,
//                       toCenter: stockRequest.center,
//                       transferDate: new Date(),
//                       transferType: "outlet_to_center",
//                     });
//                   }
//                 }

//                 outletStock.availableQuantity -= sourceDetails.outletCount;
//                 outletStock.inTransitQuantity += sourceDetails.outletCount;
                
//                 console.log(`Marked ${sourceDetails.outletCount} serials as in_transit from outlet stock`);
//               } else {
//                 // Non-serialized products from outlet
//                 outletStock.availableQuantity -= sourceDetails.outletCount;
//                 outletStock.inTransitQuantity += sourceDetails.outletCount;
                
//                 console.log(`Marked ${sourceDetails.outletCount} units as in_transit from outlet stock (non-serialized)`);
//               }

//               await outletStock.save();
//             }
//           }
//         }
//       }
//     }

//     // Now call approveRequest
//     const updatedRequest = await stockRequest.approveRequest(
//       userId,
//       productApprovals
//     );

//     const populatedRequest = await StockRequest.findById(updatedRequest._id)
//       .populate("warehouse", "_id centerName centerCode centerType")
//       .populate("center", "_id centerName centerCode centerType")
//       .populate("products.product", "_id productTitle productCode productImage")
//       .populate("approvalInfo.approvedBy", "_id fullName email")
//       .populate("createdBy", "_id fullName email")
//       .populate("updatedBy", "_id fullName email");

//     res.status(200).json({
//       success: true,
//       message: "Stock request approved successfully",
//       data: populatedRequest,
//     });
//   } catch (error) {
//     console.error("Error approving stock request:", error);

//     if (
//       error.message.includes("Number of serial numbers") ||
//       error.message.includes("Duplicate serial numbers") ||
//       error.message.includes("serial numbers not available") ||
//       error.message.includes("Approved quantity") ||
//       error.message.includes("Serial numbers are required") ||
//       error.message.includes("Serial numbers should not be provided") ||
//       error.message.includes("Approved quantity is required") ||
//       error.message.includes("Approved quantity must be a valid number") ||
//       error.message.includes("Approved quantity cannot be negative") ||
//       error.message.includes("Approval remark is required") ||
//       error.message.includes("No stock available") ||
//       error.message.includes("Insufficient stock")
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "Validation failed",
//         error: error.message,
//       });
//     }

//     if (error.code === 11000 && error.keyPattern && error.keyPattern.challanNo) {
//       return res.status(400).json({
//         success: false,
//         message: "Duplicate challan number generated. Please try again.",
//         error: "Challan number conflict",
//       });
//     }

//     res.status(500).json({
//       success: false,
//       message: "Error approving stock request",
//       error:
//         process.env.NODE_ENV === "development"
//           ? error.message
//           : "Internal server error",
//     });
//   }
// };



export const approveStockRequest = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["stock_transfer_approve_from_outlet", "manage_indent"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. stock_transfer_approve_from_outlet or manage_indent permission required.",
      });
    }

    const { id } = req.params;
    const { productApprovals } = req.body;

    const stockRequest = await StockRequest.findById(id)
      .populate("center", "reseller centerType centerName centerCode")
      .populate("warehouse", "centerType centerName centerCode");

    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only approve stock requests from your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const resellerId = stockRequest.center?.reseller?._id || stockRequest.center?.reseller;
    const centerType = stockRequest.center?.centerType;

    if (centerType === "Center" && !resellerId) {
      return res.status(400).json({
        success: false,
        message: `Center "${stockRequest.center?.centerName || stockRequest.center}" is of type "Center" but does not have an associated reseller. Please update the center information.`,
        centerId: stockRequest.center?._id,
        centerName: stockRequest.center?.centerName,
      });
    }

    const ResellerStock = mongoose.model("ResellerStock");
    const OutletStock = mongoose.model("OutletStock");
    const Product = mongoose.model("Product");

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 1: Validate all product approvals + calculate source breakdowns
    // ─────────────────────────────────────────────────────────────────────────
    if (productApprovals && productApprovals.length > 0) {
      for (const approval of productApprovals) {
        const productItem = stockRequest.products.find(
          (p) => p.product.toString() === approval.productId.toString()
        );

        if (!productItem) {
          return res.status(400).json({
            success: false,
            message: `Product ${approval.productId} not found in stock request`,
          });
        }

        if (approval.approvedQuantity === undefined || approval.approvedQuantity === null) {
          return res.status(400).json({
            success: false,
            message: `Approved quantity is required for product ${productItem.product}`,
          });
        }

        if (typeof approval.approvedQuantity !== "number" || isNaN(approval.approvedQuantity)) {
          return res.status(400).json({
            success: false,
            message: `Approved quantity must be a valid number for product ${productItem.product}`,
          });
        }

        if (approval.approvedQuantity < 0) {
          return res.status(400).json({
            success: false,
            message: `Approved quantity cannot be negative for product ${productItem.product}`,
          });
        }

        if (approval.approvedQuantity === 0 && (!approval.approvedRemark || approval.approvedRemark.trim() === "")) {
          return res.status(400).json({
            success: false,
            message: `Approval remark is required when approved quantity is zero for product ${productItem.product}`,
          });
        }

        const productDoc = await Product.findById(approval.productId);
        if (!productDoc) {
          return res.status(400).json({
            success: false,
            message: `Product document not found for ID ${approval.productId}`,
          });
        }

        const tracksSerialNumbers = productDoc.trackSerialNumber === "Yes";

        let resellerAvailable = 0;
        let outletAvailable = 0;
        let hasResellerStock = false;

        if (resellerId) {
          const resellerStock = await ResellerStock.findOne({
            reseller: resellerId,
            product: approval.productId,
          });
          if (resellerStock) {
            resellerAvailable = resellerStock.availableQuantity || 0;
            hasResellerStock = true;
          }
        }

        const outletStockDoc = await OutletStock.findOne({
          outlet: stockRequest.warehouse,
          product: approval.productId,
        });
        if (outletStockDoc) {
          outletAvailable = outletStockDoc.availableQuantity || 0;
        }

        let fromResellerQty = 0;
        let fromOutletQty = 0;
        let fromResellerSerials = [];
        let fromOutletSerials = [];

        if (tracksSerialNumbers && approval.approvedSerials && approval.approvedSerials.length > 0) {
          if (approval.approvedSerials.length !== approval.approvedQuantity) {
            return res.status(400).json({
              success: false,
              message: `Number of serial numbers (${approval.approvedSerials.length}) must match approved quantity (${approval.approvedQuantity}) for product ${productDoc.productTitle}`,
            });
          }

          const serials = approval.approvedSerials;

          if (hasResellerStock && resellerAvailable > 0) {
            const resellerStockDoc = await ResellerStock.findOne({
              reseller: resellerId,
              product: approval.productId,
            });

            if (resellerStockDoc) {
              for (const serialNumber of serials) {
                const serial = resellerStockDoc.serialNumbers.find(
                  (sn) => sn.serialNumber === serialNumber && sn.status === "available"
                );
                if (serial) {
                  fromResellerSerials.push(serialNumber);
                }
              }
            }
          }

          fromOutletSerials = serials.filter(
            (sn) => !fromResellerSerials.includes(sn)
          );

          fromResellerQty = fromResellerSerials.length;
          fromOutletQty = fromOutletSerials.length;

          if (fromOutletQty > outletAvailable) {
            return res.status(400).json({
              success: false,
              message: `Insufficient outlet stock for product "${productDoc.productTitle}". Outlet available: ${outletAvailable}, required from outlet: ${fromOutletQty}`,
            });
          }

          if (fromResellerSerials.length > 0 && hasResellerStock) {
            const resellerStockDoc = await ResellerStock.findOne({
              reseller: resellerId,
              product: approval.productId,
            });

            for (const serialNumber of fromResellerSerials) {
              const serial = resellerStockDoc?.serialNumbers.find(
                (sn) => sn.serialNumber === serialNumber && sn.status === "available"
              );
              if (!serial) {
                return res.status(400).json({
                  success: false,
                  message: `Serial number ${serialNumber} is not available in reseller stock for product "${productDoc.productTitle}"`,
                });
              }
            }
          }

          if (fromOutletSerials.length > 0 && outletStockDoc) {
            for (const serialNumber of fromOutletSerials) {
              const serial = outletStockDoc.serialNumbers.find(
                (sn) => sn.serialNumber === serialNumber && sn.status === "available"
              );
              if (!serial) {
                return res.status(400).json({
                  success: false,
                  message: `Serial number ${serialNumber} is not available in outlet stock for product "${productDoc.productTitle}"`,
                });
              }
            }
          }
        } else {
          if (approval.approvedQuantity > 0) {
            fromResellerQty = Math.min(approval.approvedQuantity, resellerAvailable);
            const remaining = approval.approvedQuantity - fromResellerQty;

            if (remaining > outletAvailable) {
              return res.status(400).json({
                success: false,
                message: `Insufficient stock for product "${productDoc.productTitle}". ` +
                  `Reseller available: ${resellerAvailable}, Outlet available: ${outletAvailable}, ` +
                  `Total approved: ${approval.approvedQuantity}, Total available: ${resellerAvailable + outletAvailable}`,
              });
            }

            fromOutletQty = remaining;
          }
        }

        if (fromResellerQty + fromOutletQty !== approval.approvedQuantity) {
          return res.status(400).json({
            success: false,
            message: `Source breakdown mismatch for product "${productDoc.productTitle}". ` +
              `Expected ${approval.approvedQuantity}, got Reseller: ${fromResellerQty} + Outlet: ${fromOutletQty}`,
          });
        }

        approval.sourceBreakdown = {
          fromReseller: {
            quantity: fromResellerQty,
            serials: fromResellerSerials,
          },
          fromOutlet: {
            quantity: fromOutletQty,
            serials: fromOutletSerials,
          },
          totalApproved: approval.approvedQuantity,
        };
      }

      // ─────────────────────────────────────────────────────────────────────
      // PHASE 2: All validations passed — now apply stock changes with FRESH FETCH
      // ─────────────────────────────────────────────────────────────────────
      for (const approval of productApprovals) {
        // ── Deduct from outlet stock (mark in_transit) ────────────────────
        if (approval.approvedQuantity > 0 && approval.sourceBreakdown.fromOutlet.quantity > 0) {
          // 🔄 FRESH FETCH right before deduction to avoid stale data
          const outletStock = await OutletStock.findOne({
            outlet: stockRequest.warehouse,
            product: approval.productId,
          });

          const outletQty = approval.sourceBreakdown.fromOutlet.quantity;
          const outletSerials = approval.sourceBreakdown.fromOutlet.serials;

          // ✅ Check again with fresh data
          if (!outletStock) {
            return res.status(400).json({
              success: false,
              message: `Outlet stock record not found for product ${approval.productId}`,
            });
          }

          if (outletStock.availableQuantity < outletQty) {
            return res.status(400).json({
              success: false,
              message: `Outlet stock changed! Available now: ${outletStock.availableQuantity}, Required: ${outletQty}. Please retry.`,
            });
          }

          // ✅ Use atomic update to prevent race conditions
          if (outletSerials.length > 0) {
            for (const serialNumber of outletSerials) {
              const serial = outletStock.serialNumbers.find(
                (sn) => sn.serialNumber === serialNumber
              );

              if (serial && serial.status === "available") {
                serial.status = "in_transit";
                serial.currentLocation = stockRequest.warehouse;

                serial.transferHistory.push({
                  fromCenter: stockRequest.warehouse,
                  toCenter: stockRequest.center,
                  transferDate: new Date(),
                  transferType: "outlet_to_center",
                  status: "in_transit",
                });
              } else {
                return res.status(400).json({
                  success: false,
                  message: `Serial number ${serialNumber} is no longer available in outlet stock`,
                });
              }
            }

            outletStock.availableQuantity -= outletSerials.length;
            outletStock.inTransitQuantity += outletSerials.length;
          } else {
            // ✅ Atomic operation using $inc
            const updateResult = await OutletStock.updateOne(
              {
                _id: outletStock._id,
                availableQuantity: { $gte: outletQty } // Atomic condition
              },
              {
                $inc: {
                  availableQuantity: -outletQty,
                  inTransitQuantity: outletQty
                }
              }
            );

            if (updateResult.modifiedCount === 0) {
              return res.status(409).json({
                success: false,
                message: `Stock changed during approval for product. Please retry.`,
              });
            }
            
            // Skip the manual save since we used updateOne
            await outletStock.save(); // This will still work for serials case
          }
          
          if (outletSerials.length === 0) {
            // For non-serial, we already updated via updateOne, so skip save
            continue;
          }
          await outletStock.save();
        }

        // ── Deduct from reseller stock (mark consumed) ────────────────────
        if (approval.sourceBreakdown.fromReseller.quantity > 0 && resellerId) {
          // 🔄 FRESH FETCH for reseller stock too
          const resellerStock = await ResellerStock.findOne({
            reseller: resellerId,
            product: approval.productId,
          });

          const resellerQty = approval.sourceBreakdown.fromReseller.quantity;
          const resellerSerials = approval.sourceBreakdown.fromReseller.serials;

          if (!resellerStock) {
            return res.status(400).json({
              success: false,
              message: `Reseller stock record not found for product ${approval.productId}`,
            });
          }

          if (resellerStock.availableQuantity < resellerQty) {
            return res.status(400).json({
              success: false,
              message: `Reseller stock changed! Available now: ${resellerStock.availableQuantity}, Required: ${resellerQty}. Please retry.`,
            });
          }

          if (resellerSerials.length > 0) {
            for (const serialNumber of resellerSerials) {
              const serial = resellerStock.serialNumbers.find(
                (sn) => sn.serialNumber === serialNumber
              );

              if (serial && serial.status === "available") {
                serial.status = "consumed";
                serial.currentLocation = stockRequest.center;
                serial.consumedDate = new Date();
                serial.consumedBy = userId;

                serial.transferHistory.push({
                  fromCenter: null,
                  toCenter: stockRequest.center,
                  transferDate: new Date(),
                  transferType: "outbound_transfer",
                  remark: "Stock request approval",
                  transferredBy: userId,
                  referenceId: stockRequest._id,
                });
              } else {
                return res.status(400).json({
                  success: false,
                  message: `Serial number ${serialNumber} is no longer available in reseller stock`,
                });
              }
            }

            resellerStock.availableQuantity -= resellerSerials.length;
            resellerStock.consumedQuantity += resellerSerials.length;
          } else {
            // ✅ Atomic update for non-serial reseller stock
            const updateResult = await ResellerStock.updateOne(
              {
                _id: resellerStock._id,
                availableQuantity: { $gte: resellerQty }
              },
              {
                $inc: {
                  availableQuantity: -resellerQty,
                  consumedQuantity: resellerQty
                }
              }
            );

            if (updateResult.modifiedCount === 0) {
              return res.status(409).json({
                success: false,
                message: `Reseller stock changed during approval. Please retry.`,
              });
            }
            continue;
          }

          await resellerStock.save();
        }
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PHASE 3: Persist updated products + call approveRequest
    // ─────────────────────────────────────────────────────────────────────────
    const updatedProducts = stockRequest.products.map((productItem) => {
      const approval = productApprovals?.find(
        (pa) => pa.productId.toString() === productItem.product.toString()
      );

      if (approval) {
        return {
          ...productItem.toObject(),
          approvedQuantity: approval.approvedQuantity,
          approvedRemark: approval.approvedRemark || "",
          approvedSerials: approval.approvedSerials || [],
          sourceBreakdown: approval.sourceBreakdown || {
            fromReseller: { quantity: 0, serials: [] },
            fromOutlet: { quantity: 0, serials: [] },
            totalApproved: 0,
          },
        };
      }
      return productItem;
    });

    stockRequest.products = updatedProducts;
    await stockRequest.save();

    const updatedRequest = await stockRequest.approveRequest(
      userId,
      productApprovals
    );

    const populatedRequest = await StockRequest.findById(updatedRequest._id)
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode centerType")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate("approvalInfo.approvedBy", "_id fullName email")
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message: "Stock request approved successfully",
      data: populatedRequest,
    });
  } catch (error) {
    console.error("Error approving stock request:", error);

    if (
      error.message.includes("Number of serial numbers") ||
      error.message.includes("Duplicate serial numbers") ||
      error.message.includes("serial numbers not available") ||
      error.message.includes("Approved quantity") ||
      error.message.includes("Serial numbers are required") ||
      error.message.includes("Serial numbers should not be provided") ||
      error.message.includes("Approved quantity is required") ||
      error.message.includes("Approved quantity must be a valid number") ||
      error.message.includes("Approved quantity cannot be negative") ||
      error.message.includes("Approval remark is required") ||
      error.message.includes("No stock available") ||
      error.message.includes("Insufficient stock") ||
      error.message.includes("Stock changed")
    ) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        error: error.message,
      });
    }

    if (
      error.code === 11000 &&
      error.keyPattern &&
      error.keyPattern.challanNo
    ) {
      return res.status(400).json({
        success: false,
        message: "Duplicate challan number generated. Please try again.",
        error: "Challan number conflict",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error approving stock request",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const shipStockRequest = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["manage_indent"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. manage_indent permission required.",
      });
    }

    const { id } = req.params;
    const {
      shippedDate,
      expectedDeliveryDate,
      shipmentDetails,
      shipmentRemark,
      documents,
    } = req.body;

    const stockRequest = await StockRequest.findById(id);
    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only ship stock requests from your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const shippingDetails = {
      shippedDate: new Date(shippedDate),
      ...(expectedDeliveryDate && {
        expectedDeliveryDate: new Date(expectedDeliveryDate),
      }),
      ...(shipmentDetails && { shipmentDetails }),
      ...(shipmentRemark && { shipmentRemark }),
      ...(documents && {
        documents: Array.isArray(documents) ? documents : [documents],
      }),
    };

    const updatedRequest = await stockRequest.shipRequest(
      userId,
      shippingDetails
    );

    const populatedRequest = await StockRequest.findById(updatedRequest._id)
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate("shippingInfo.shippedBy", "_id fullName email")
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message: "Stock request shipped successfully",
      data: populatedRequest,
    });
  } catch (error) {
    console.error("Error shipping stock request:", error);
    res.status(500).json({
      success: false,
      message: "Error shipping stock request",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const updateShippingInfo = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["manage_indent"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. manage_indent permission required.",
      });f
    }

    const { id } = req.params;
    const {
      shippedDate,
      expectedDeliveryDate,
      shipmentDetails,
      shipmentRemark,
      documents,
    } = req.body;

    const stockRequest = await StockRequest.findById(id);
    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only update shipping info for stock requests from your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const shippingDetails = {
      ...(shippedDate && { shippedDate: new Date(shippedDate) }),
      ...(expectedDeliveryDate && {
        expectedDeliveryDate: new Date(expectedDeliveryDate),
      }),
      ...(shipmentDetails && { shipmentDetails }),
      ...(shipmentRemark && { shipmentRemark }),
      ...(documents && {
        documents: Array.isArray(documents) ? documents : [documents],
      }),
    };

    const updatedRequest = await stockRequest.updateShippingInfo(
      shippingDetails
    );

    updatedRequest.updatedBy = userId;
    await updatedRequest.save();

    const populatedRequest = await StockRequest.findById(updatedRequest._id)
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate("shippingInfo.shippedBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email")
      .populate("createdBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message: "Shipping information updated successfully",
      data: populatedRequest,
    });
  } catch (error) {
    console.error("Error updating shipping information:", error);
    res.status(500).json({
      success: false,
      message: "Error updating shipping information",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const rejectShipment = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["manage_indent"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. manage_indent permission required.",
      });
    }

    const { id } = req.params;

    const stockRequest = await StockRequest.findById(id);
    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only reject shipments for stock requests from your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const updatedRequest = await stockRequest.rejectShipment(userId);

    updatedRequest.updatedBy = userId;
    await updatedRequest.save();

    const populatedRequest = await StockRequest.findById(updatedRequest._id)
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate(
        "shippingInfo.shipmentRejected.rejectedBy",
        "_id fullName email"
      )
      .populate("updatedBy", "_id fullName email")
      .populate("createdBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message:
        "Shipment rejected successfully. Shipping details cleared and status reverted to Confirmed.",
      data: populatedRequest,
    });
  } catch (error) {
    console.error("Error rejecting shipment:", error);
    res.status(500).json({
      success: false,
      message: "Error rejecting shipment",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

// export const markAsIncomplete = async (req, res) => {
//   try {
//     const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
//       req,
//       ["manage_indent"]
//     );

//     if (!hasAccess) {
//       return res.status(403).json({
//         success: false,
//         message: "Access denied. manage_indent permission required.",
//       });
//     }

//     const { id } = req.params;
//     const { incompleteRemark, receivedProducts } = req.body;

//     const stockRequest = await StockRequest.findById(id);
//     if (!stockRequest) {
//       return res.status(404).json({
//         success: false,
//         message: "Stock request not found",
//       });
//     }

//     if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
//       return res.status(403).json({
//         success: false,
//         message:
//           "Access denied. You can only mark stock requests from your own center as incomplete.",
//       });
//     }

//     const userId = req.user?.id;
//     if (!userId) {
//       return res.status(400).json({
//         success: false,
//         message: "User authentication required",
//       });
//     }

//     if (receivedProducts && Array.isArray(receivedProducts)) {
//       const Product = mongoose.model("Product");

//       for (const receivedProduct of receivedProducts) {
//         if (!receivedProduct.productId) {
//           return res.status(400).json({
//             success: false,
//             message: "Product ID is required for each received product",
//           });
//         }

//         if (
//           receivedProduct.receivedQuantity === undefined ||
//           receivedProduct.receivedQuantity === null
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity is required for product ${receivedProduct.productId}`,
//           });
//         }

//         if (
//           typeof receivedProduct.receivedQuantity !== "number" ||
//           isNaN(receivedProduct.receivedQuantity)
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity must be a valid number for product ${receivedProduct.productId}`,
//           });
//         }

//         if (receivedProduct.receivedQuantity < 0) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity cannot be negative for product ${receivedProduct.productId}`,
//           });
//         }

//         if (!Number.isInteger(receivedProduct.receivedQuantity)) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity must be an integer for product ${receivedProduct.productId}`,
//           });
//         }

//         const productItem = stockRequest.products.find(
//           (p) => p.product.toString() === receivedProduct.productId.toString()
//         );

//         if (!productItem) {
//           return res.status(400).json({
//             success: false,
//             message: `Product ${receivedProduct.productId} not found in stock request`,
//           });
//         }

//         if (receivedProduct.receivedQuantity > productItem.approvedQuantity) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity (${receivedProduct.receivedQuantity}) cannot exceed approved quantity (${productItem.approvedQuantity}) for product ${receivedProduct.productId}`,
//           });
//         }

//         const productDoc = await Product.findById(receivedProduct.productId);
//         const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";
//       }

//       stockRequest.products = stockRequest.products.map((productItem) => {
//         const receivedProduct = receivedProducts.find(
//           (rp) => rp.productId.toString() === productItem.product.toString()
//         );

//         if (receivedProduct) {
//           return {
//             ...productItem.toObject(),
//             receivedQuantity: receivedProduct.receivedQuantity || 0,
//             receivedRemark: receivedProduct.receivedRemark || "",
//             receivedSerials: receivedProduct.receivedSerials || [],
//           };
//         }
//         return productItem;
//       });
//     }

//     const currentDate = new Date();

//     stockRequest.status = "Incompleted";
//     stockRequest.updatedBy = userId;
//     stockRequest.completionInfo = {
//       ...stockRequest.completionInfo,
//       incompleteOn: currentDate,
//       incompleteBy: userId,
//       incompleteRemark: incompleteRemark || "",
//     };

//     const updatedRequest = await stockRequest.save();

//     const populatedRequest = await StockRequest.findById(updatedRequest._id)
//       .populate("warehouse", "_id centerName centerCode centerType")
//       .populate("center", "_id centerName centerCode")
//       .populate("products.product", "_id productTitle productCode productImage")
//       .populate("incompleteInfo.incompleteBy", "_id fullName email")
//       .populate("createdBy", "_id fullName email")
//       .populate("updatedBy", "_id fullName email");

//     res.status(200).json({
//       success: true,
//       message: "Stock request marked as incomplete successfully",
//       data: populatedRequest,
//     });
//   } catch (error) {
//     console.error("Error marking stock request as incomplete:", error);

//     if (
//       error.message.includes("Received quantity") ||
//       error.message.includes("Product ID") ||
//       error.message.includes("serial numbers") ||
//       error.message.includes("exceed approved quantity")
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "Validation failed",
//         error: error.message,
//       });
//     }

//     res.status(500).json({
//       success: false,
//       message: "Error marking stock request as incomplete",
//       error:
//         process.env.NODE_ENV === "development"
//           ? error.message
//           : "Internal server error",
//     });
//   }
// };


/////**************** in below to handle extra received qty **************/
// export const markAsIncomplete = async (req, res) => {
//   try {
//     const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
//       req,
//       ["manage_indent"]
//     );

//     if (!hasAccess) {
//       return res.status(403).json({
//         success: false,
//         message: "Access denied. manage_indent permission required.",
//       });
//     }

//     const { id } = req.params;
//     const { incompleteRemark, receivedProducts } = req.body;

//     const stockRequest = await StockRequest.findById(id);
//     if (!stockRequest) {
//       return res.status(404).json({
//         success: false,
//         message: "Stock request not found",
//       });
//     }

//     if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
//       return res.status(403).json({
//         success: false,
//         message:
//           "Access denied. You can only mark stock requests from your own center as incomplete.",
//       });
//     }

//     const userId = req.user?.id;
//     if (!userId) {
//       return res.status(400).json({
//         success: false,
//         message: "User authentication required",
//       });
//     }

//     if (receivedProducts && Array.isArray(receivedProducts)) {
//       const Product = mongoose.model("Product");
//       const OutletStock = mongoose.model("OutletStock");

//       for (const receivedProduct of receivedProducts) {
//         if (!receivedProduct.productId) {
//           return res.status(400).json({
//             success: false,
//             message: "Product ID is required for each received product",
//           });
//         }

//         if (
//           receivedProduct.receivedQuantity === undefined ||
//           receivedProduct.receivedQuantity === null
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity is required for product ${receivedProduct.productId}`,
//           });
//         }

//         if (
//           typeof receivedProduct.receivedQuantity !== "number" ||
//           isNaN(receivedProduct.receivedQuantity)
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity must be a valid number for product ${receivedProduct.productId}`,
//           });
//         }

//         if (receivedProduct.receivedQuantity < 0) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity cannot be negative for product ${receivedProduct.productId}`,
//           });
//         }

//         if (!Number.isInteger(receivedProduct.receivedQuantity)) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity must be an integer for product ${receivedProduct.productId}`,
//           });
//         }

//         const productItem = stockRequest.products.find(
//           (p) => p.product.toString() === receivedProduct.productId.toString()
//         );

//         if (!productItem) {
//           return res.status(400).json({
//             success: false,
//             message: `Product ${receivedProduct.productId} not found in stock request`,
//           });
//         }

//         // Check if received quantity exceeds approved quantity
//         if (receivedProduct.receivedQuantity > productItem.approvedQuantity) {
//           const additionalQuantity = receivedProduct.receivedQuantity - productItem.approvedQuantity;
          
//           console.log(`[DEBUG] Received quantity (${receivedProduct.receivedQuantity}) > Approved quantity (${productItem.approvedQuantity})`);
//           console.log(`[DEBUG] Additional quantity needed: ${additionalQuantity}`);
          
//           // Check outlet stock availability for the additional quantity
//           const outletStock = await OutletStock.findOne({
//             outlet: stockRequest.warehouse,
//             product: receivedProduct.productId,
//           });

//           if (!outletStock) {
//             return res.status(400).json({
//               success: false,
//               message: `No stock found in outlet for product ${receivedProduct.productId}`,
//             });
//           }

//           console.log(`[DEBUG] Outlet stock before - Available: ${outletStock.availableQuantity}, InTransit: ${outletStock.inTransitQuantity}, Total: ${outletStock.totalQuantity}`);

//           // Get product info
//           const productDoc = await Product.findById(receivedProduct.productId);
//           const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";

//           if (tracksSerialNumbers) {
//             // For serialized products, we'll handle serials during completion
//             // Just check if enough quantity is available
//             if (outletStock.availableQuantity < additionalQuantity) {
//               return res.status(400).json({
//                 success: false,
//                 message: `Insufficient stock in outlet for additional quantity of product "${productDoc?.productTitle || receivedProduct.productId}". Available: ${outletStock.availableQuantity}, Needed: ${additionalQuantity}`,
//               });
//             }

//             console.log(`[DEBUG] Serialized product - will handle serials during completion`);
            
//           } else {
//             // For non-serialized products, check availability
//             if (outletStock.availableQuantity < additionalQuantity) {
//               return res.status(400).json({
//                 success: false,
//                 message: `Insufficient stock in outlet for additional quantity of product ${receivedProduct.productId}. Available: ${outletStock.availableQuantity}, Needed: ${additionalQuantity}`,
//               });
//             }
//           }

//           // IMPORTANT: DO NOT update outlet stock here
//           // We'll handle the stock update during completion when serials are provided
//           console.log(`[DEBUG] NOT updating outlet stock. Will handle during completion with proper serials.`);
          
//           // Store a flag to indicate additional quantity is needed
//           receivedProduct._requiresAdditionalStock = true;
//           receivedProduct._additionalQuantity = additionalQuantity;
//         }

//         // Basic serial validation if provided (optional)
//         if (receivedProduct.receivedSerials && Array.isArray(receivedProduct.receivedSerials)) {
//           const productDoc = await Product.findById(receivedProduct.productId);
//           const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";
          
//           if (tracksSerialNumbers) {
//             if (receivedProduct.receivedSerials.length !== receivedProduct.receivedQuantity) {
//               return res.status(400).json({
//                 success: false,
//                 message: `Number of serial numbers (${receivedProduct.receivedSerials.length}) must match received quantity (${receivedProduct.receivedQuantity}) for product "${productDoc.productTitle}"`,
//               });
//             }
//           }
//         }
//       }

//       // Update stock request products with received quantities
//       // BUT don't update approved quantities or serials yet
//       stockRequest.products = stockRequest.products.map((productItem) => {
//         const receivedProduct = receivedProducts.find(
//           (rp) => rp.productId.toString() === productItem.product.toString()
//         );

//         if (receivedProduct) {
//           return {
//             ...productItem.toObject(),
//             receivedQuantity: receivedProduct.receivedQuantity || 0,
//             receivedRemark: receivedProduct.receivedRemark || "",
//             receivedSerials: receivedProduct.receivedSerials || [],
//             // Keep approved quantities as they are for now
//             // They'll be updated during completion
//           };
//         }
//         return productItem;
//       });
//     }

//     const currentDate = new Date();

//     stockRequest.status = "Incompleted";
//     stockRequest.updatedBy = userId;
//     stockRequest.completionInfo = {
//       ...stockRequest.completionInfo,
//       incompleteOn: currentDate,
//       incompleteBy: userId,
//       incompleteRemark: incompleteRemark || "",
//     };

//     const updatedRequest = await stockRequest.save();

//     const populatedRequest = await StockRequest.findById(updatedRequest._id)
//       .populate("warehouse", "_id centerName centerCode centerType")
//       .populate("center", "_id centerName centerCode")
//       .populate("products.product", "_id productTitle productCode productImage")
//       .populate("completionInfo.incompleteBy", "_id fullName email")
//       .populate("createdBy", "_id fullName email")
//       .populate("updatedBy", "_id fullName email");

//     res.status(200).json({
//       success: true,
//       message: "Stock request marked as incomplete successfully. Note: For received quantity > approved quantity, additional stock and serials will be handled during completion.",
//       data: populatedRequest,
//     });
//   } catch (error) {
//     console.error("Error marking stock request as incomplete:", error);

//     if (
//       error.message.includes("Received quantity") ||
//       error.message.includes("Product ID") ||
//       error.message.includes("serial numbers") ||
//       error.message.includes("exceed approved quantity") ||
//       error.message.includes("Insufficient stock") ||
//       error.message.includes("Serial number") ||
//       error.message.includes("not available")
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "Validation failed",
//         error: error.message,
//       });
//     }

//     res.status(500).json({
//       success: false,
//       message: "Error marking stock request as incomplete",
//       error:
//         process.env.NODE_ENV === "development"
//           ? error.message
//           : "Internal server error",
//     });
//   }
// };

export const markAsIncomplete = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["manage_indent"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. manage_indent permission required.",
      });
    }

    const { id } = req.params;
    const { incompleteRemark, receivedProducts } = req.body;

    const stockRequest = await StockRequest.findById(id)
      .populate("center", "reseller");
    
    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only mark stock requests from your own center as incomplete.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const ResellerStock = mongoose.model("ResellerStock");
    const OutletStock = mongoose.model("OutletStock");
    const Product = mongoose.model("Product");

    const resellerId = stockRequest.center?.reseller?._id;

    // ============================================================
    // RESTORE RESELLER STOCK for quantities NOT received
    // ============================================================
    if (receivedProducts && Array.isArray(receivedProducts)) {
      for (const receivedProduct of receivedProducts) {
        const productItem = stockRequest.products.find(
          (p) => p.product.toString() === receivedProduct.productId.toString()
        );

        if (!productItem) {
          return res.status(400).json({
            success: false,
            message: `Product ${receivedProduct.productId} not found in stock request`,
          });
        }

        // Calculate quantity that is NOT being received
        const approvedQuantity = productItem.approvedQuantity || 0;
        const receivedQuantity = receivedProduct.receivedQuantity || 0;
        const quantityToRestore = approvedQuantity - receivedQuantity;

        console.log(`[DEBUG] Product ${receivedProduct.productId}:`);
        console.log(`[DEBUG]   Approved: ${approvedQuantity}`);
        console.log(`[DEBUG]   Received: ${receivedQuantity}`);
        console.log(`[DEBUG]   To Restore: ${quantityToRestore}`);

        if (quantityToRestore > 0) {
          const productDoc = await Product.findById(receivedProduct.productId);
          const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";
          
          // Get source breakdown to know how much came from reseller
          const sourceBreakdown = productItem.sourceBreakdown || {
            fromReseller: { quantity: 0, serials: [] },
            fromOutlet: { quantity: 0, serials: [] }
          };

          const resellerQuantity = sourceBreakdown.fromReseller.quantity || 0;
          
          if (resellerQuantity > 0 && resellerId) {
            // Calculate how many reseller units to restore (based on ratio)
            const resellerRestoreQuantity = Math.min(
              quantityToRestore,
              resellerQuantity
            );

            if (resellerRestoreQuantity > 0) {
              const resellerStock = await ResellerStock.findOne({
                reseller: resellerId,
                product: receivedProduct.productId,
              });

              if (resellerStock) {
                if (tracksSerialNumbers && sourceBreakdown.fromReseller.serials) {
                  // RESTORE SPECIFIC SERIALS from reseller
                  const serialsToRestore = sourceBreakdown.fromReseller.serials.slice(
                    receivedQuantity, 
                    receivedQuantity + resellerRestoreQuantity
                  );

                  for (const serialNumber of serialsToRestore) {
                    const serial = resellerStock.serialNumbers.find(
                      sn => sn.serialNumber === serialNumber
                    );

                    if (serial && serial.status === "consumed") {
                      serial.status = "available";
                      serial.consumedDate = null;
                      serial.consumedBy = null;
                      serial.currentLocation = null;
                      
                      // Remove from transfer history
                      serial.transferHistory = serial.transferHistory.filter(
                        th => th.referenceId?.toString() !== stockRequest._id.toString()
                      );
                      
                      console.log(`[DEBUG] Restored reseller serial ${serialNumber}`);
                    }
                  }

                  resellerStock.availableQuantity += serialsToRestore.length;
                  resellerStock.consumedQuantity -= serialsToRestore.length;
                } else {
                  // Non-serialized - restore quantity
                  resellerStock.availableQuantity += resellerRestoreQuantity;
                  resellerStock.consumedQuantity -= resellerRestoreQuantity;
                }

                await resellerStock.save();
                console.log(`[DEBUG] Restored ${resellerRestoreQuantity} units to reseller stock`);
              }
            }
          }

          // Also restore outlet stock if needed (for in_transit items not received)
          const outletQuantity = sourceBreakdown.fromOutlet.quantity || 0;
          const outletRestoreQuantity = Math.min(quantityToRestore, outletQuantity);
          
          if (outletRestoreQuantity > 0) {
            const outletStock = await OutletStock.findOne({
              outlet: stockRequest.warehouse,
              product: receivedProduct.productId,
            });

            if (outletStock) {
              if (tracksSerialNumbers && sourceBreakdown.fromOutlet.serials) {
                const serialsToRestore = sourceBreakdown.fromOutlet.serials.slice(
                  receivedQuantity,
                  receivedQuantity + outletRestoreQuantity
                );

                for (const serialNumber of serialsToRestore) {
                  const serial = outletStock.serialNumbers.find(
                    sn => sn.serialNumber === serialNumber
                  );

                  if (serial && serial.status === "in_transit") {
                    serial.status = "available";
                    serial.currentLocation = stockRequest.warehouse;
                    
                    // Remove transfer history
                    if (serial.transferHistory.length > 0) {
                      const lastTransfer = serial.transferHistory[serial.transferHistory.length - 1];
                      if (lastTransfer.status === "in_transit") {
                        serial.transferHistory.pop();
                      }
                    }
                    
                    console.log(`[DEBUG] Restored outlet serial ${serialNumber}`);
                  }
                }

                outletStock.availableQuantity += serialsToRestore.length;
                outletStock.inTransitQuantity -= serialsToRestore.length;
              } else {
                outletStock.availableQuantity += outletRestoreQuantity;
                outletStock.inTransitQuantity -= outletRestoreQuantity;
              }

              await outletStock.save();
              console.log(`[DEBUG] Restored ${outletRestoreQuantity} units to outlet stock`);
            }
          }
        }
      }
    }

    // Update stock request products with received quantities
    if (receivedProducts && Array.isArray(receivedProducts)) {
      stockRequest.products = stockRequest.products.map((productItem) => {
        const receivedProduct = receivedProducts.find(
          (rp) => rp.productId.toString() === productItem.product.toString()
        );

        if (receivedProduct) {
          return {
            ...productItem.toObject(),
            receivedQuantity: receivedProduct.receivedQuantity || 0,
            receivedRemark: receivedProduct.receivedRemark || "",
            receivedSerials: receivedProduct.receivedSerials || [],
          };
        }
        return productItem;
      });
    }

    const currentDate = new Date();

    stockRequest.status = "Incompleted";
    stockRequest.updatedBy = userId;
    
    stockRequest.incompleteInfo = {
      incompleteOn: currentDate,
      incompleteBy: userId,
      incompleteRemark: incompleteRemark || "",
      incompleteReceipts: receivedProducts ? receivedProducts.map(rp => ({
        productId: rp.productId,
        receivedQuantity: rp.receivedQuantity,
        receivedRemark: rp.receivedRemark || "",
        receivedSerials: rp.receivedSerials || [],
      })) : []
    };

    stockRequest.completionInfo = {
      completedOn: undefined,
      completedBy: undefined,
    };

    const updatedRequest = await stockRequest.save();

    const populatedRequest = await StockRequest.findById(updatedRequest._id)
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate("incompleteInfo.incompleteBy", "_id fullName email")
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message: "Stock request marked as incomplete successfully. Reseller stock restored for unreceived quantities.",
      data: populatedRequest,
    });
  } catch (error) {
    console.error("Error marking stock request as incomplete:", error);
    res.status(500).json({
      success: false,
      message: "Error marking stock request as incomplete",
      error: error.message,
    });
  }
};

// export const completeIncompleteRequest = async (req, res) => {
//   try {
//     const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
//       req,
//       ["manage_indent"]
//     );

//     if (!hasAccess) {
//       return res.status(403).json({
//         success: false,
//         message: "Access denied. manage_indent permission required.",
//       });
//     }

//     const { id } = req.params;
//     const { productApprovals, productReceipts } = req.body;

//     const stockRequest = await StockRequest.findById(id);
//     if (!stockRequest) {
//       return res.status(404).json({
//         success: false,
//         message: "Stock request not found",
//       });
//     }

//     if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
//       return res.status(403).json({
//         success: false,
//         message:
//           "Access denied. You can only complete incomplete stock requests from your own center.",
//       });
//     }

//     if (stockRequest.status !== "Incompleted") {
//       return res.status(400).json({
//         success: false,
//         message: "Only incomplete stock requests can be completed",
//       });
//     }

//     const userId = req.user?.id;
//     if (!userId) {
//       return res.status(400).json({
//         success: false,
//         message: "User authentication required",
//       });
//     }

//     if (
//       (!productApprovals ||
//         !Array.isArray(productApprovals) ||
//         productApprovals.length === 0) &&
//       (!productReceipts ||
//         !Array.isArray(productReceipts) ||
//         productReceipts.length === 0)
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "Either product approvals or product receipts are required",
//       });
//     }

//     const Product = mongoose.model("Product");

//     if (productApprovals && productApprovals.length > 0) {
//       for (const approval of productApprovals) {
//         if (!approval.productId) {
//           return res.status(400).json({
//             success: false,
//             message: "Product ID is required for each product approval",
//           });
//         }

//         if (
//           approval.approvedQuantity === undefined ||
//           approval.approvedQuantity === null
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity is required for product ${approval.productId}`,
//           });
//         }

//         if (
//           typeof approval.approvedQuantity !== "number" ||
//           isNaN(approval.approvedQuantity)
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity must be a valid number for product ${approval.productId}`,
//           });
//         }

//         if (approval.approvedQuantity < 0) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity cannot be negative for product ${approval.productId}`,
//           });
//         }

//         if (!Number.isInteger(approval.approvedQuantity)) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity must be an integer for product ${approval.productId}`,
//           });
//         }

//         const productItem = stockRequest.products.find(
//           (p) => p.product.toString() === approval.productId.toString()
//         );

//         if (!productItem) {
//           return res.status(400).json({
//             success: false,
//             message: `Product ${approval.productId} not found in stock request`,
//           });
//         }

//         if (approval.approvedQuantity > productItem.quantity) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity (${approval.approvedQuantity}) cannot exceed requested quantity (${productItem.quantity}) for product ${approval.productId}`,
//           });
//         }

//         if (
//           approval.approvedQuantity === 0 &&
//           (!approval.approvedRemark || approval.approvedRemark.trim() === "")
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Approval remark is required when approved quantity is zero for product ${approval.productId}`,
//           });
//         }

//         const productDoc = await Product.findById(approval.productId);
//         const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";

//         if (tracksSerialNumbers) {
//           if (approval.approvedQuantity > 0) {
//             const approvedSerials = approval.approvedSerials || [];

//             if (approvedSerials.length > 0) {
//               const uniqueSerials = new Set(approvedSerials);
//               if (uniqueSerials.size !== approvedSerials.length) {
//                 return res.status(400).json({
//                   success: false,
//                   message: `Duplicate serial numbers found for product ${productDoc.productTitle}`,
//                 });
//               }
//             }
//           } else {
//             if (
//               approval.approvedSerials &&
//               approval.approvedSerials.length > 0
//             ) {
//               return res.status(400).json({
//                 success: false,
//                 message: `Approved serial numbers should not be provided when approved quantity is zero for product ${productDoc.productTitle}`,
//               });
//             }
//           }
//         } else {
//           if (approval.approvedSerials && approval.approvedSerials.length > 0) {
//             return res.status(400).json({
//               success: false,
//               message: `Approved serial numbers should not be provided for product ${productDoc.productTitle} as it does not track serial numbers`,
//             });
//           }
//         }
//       }

//       const productApprovalsWithQuantity = productApprovals.filter(
//         (pa) => pa.approvedQuantity > 0
//       );

//       if (productApprovalsWithQuantity.length > 0) {
//         const validationResults = await stockRequest.validateSerialNumbers(
//           productApprovalsWithQuantity
//         );
//         const invalidResults = validationResults.filter(
//           (result) => !result.valid
//         );

//         if (invalidResults.length > 0) {
//           return res.status(400).json({
//             success: false,
//             message: "Serial number validation failed",
//             validationErrors: invalidResults,
//           });
//         }
//       }
//     }
//     if (productReceipts && productReceipts.length > 0) {
//       for (const receipt of productReceipts) {
//         if (!receipt.productId) {
//           return res.status(400).json({
//             success: false,
//             message: "Product ID is required for each product receipt",
//           });
//         }

//         if (
//           receipt.receivedQuantity === undefined ||
//           receipt.receivedQuantity === null
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity is required for product ${receipt.productId}`,
//           });
//         }

//         if (
//           typeof receipt.receivedQuantity !== "number" ||
//           isNaN(receipt.receivedQuantity)
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity must be a valid number for product ${receipt.productId}`,
//           });
//         }

//         if (receipt.receivedQuantity < 0) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity cannot be negative for product ${receipt.productId}`,
//           });
//         }

//         if (!Number.isInteger(receipt.receivedQuantity)) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity must be an integer for product ${receipt.productId}`,
//           });
//         }

//         const productItem = stockRequest.products.find(
//           (p) => p.product.toString() === receipt.productId.toString()
//         );

//         if (!productItem) {
//           return res.status(400).json({
//             success: false,
//             message: `Product ${receipt.productId} not found in stock request`,
//           });
//         }

//         let currentApprovedQuantity = productItem.approvedQuantity;

//         if (productApprovals && productApprovals.length > 0) {
//           const approval = productApprovals.find(
//             (pa) => pa.productId.toString() === receipt.productId.toString()
//           );
//           if (approval) {
//             currentApprovedQuantity = approval.approvedQuantity;
//           }
//         }

//         if (receipt.receivedQuantity > currentApprovedQuantity) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity (${receipt.receivedQuantity}) cannot exceed approved quantity (${currentApprovedQuantity}) for product ${receipt.productId}`,
//           });
//         }
//       }
//     }

//     const OutletStock = mongoose.model("OutletStock");
//     const CenterStock = mongoose.model("CenterStock");

//     const productsToProcess = productReceipts && productReceipts.length > 0 
//       ? productReceipts 
//       : productApprovals.map((approval) => ({
//           productId: approval.productId,
//           receivedQuantity: approval.approvedQuantity,
//           receivedRemark: approval.receivedRemark || approval.approvedRemark || "",
//         }));

//     for (const receipt of productsToProcess) {
//       const productItem = stockRequest.products.find(
//         (p) => p.product.toString() === receipt.productId.toString()
//       );

//       if (!productItem) {
//         return res.status(400).json({
//           success: false,
//           message: `Product ${receipt.productId} not found in stock request`,
//         });
//       }

//       const productDoc = await Product.findById(receipt.productId);
//       const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";
      
//       const currentApprovedQuantity = productItem.approvedQuantity || 0;
//       const receivedQuantity = receipt.receivedQuantity || 0;
      
//       const outletStock = await OutletStock.findOne({
//         outlet: stockRequest.warehouse,
//         product: receipt.productId,
//       });

//       if (!outletStock) {
//         return res.status(400).json({
//           success: false,
//           message: `No stock found in outlet for product ${receipt.productId}`,
//         });
//       }

//       const quantityToRevert = currentApprovedQuantity - receivedQuantity;
      
//       console.log(`Processing product ${receipt.productId}:`);
//       console.log(`  Current approved: ${currentApprovedQuantity}`);
//       console.log(`  Received: ${receivedQuantity}`);
//       console.log(`  Quantity to revert: ${quantityToRevert}`);
//       console.log(`  Outlet stock before: Total=${outletStock.totalQuantity}, Available=${outletStock.availableQuantity}, InTransit=${outletStock.inTransitQuantity}`);

//       if (tracksSerialNumbers) {
//         const hasApprovedSerials = productItem.approvedSerials && productItem.approvedSerials.length > 0;

//         if (hasApprovedSerials) {
//           const approvedCount = productItem.approvedSerials.length;
          
//           if (quantityToRevert > 0) {
//             const serialsToRevert = productItem.approvedSerials.slice(receivedQuantity);
            
//             console.log(`  Reverting ${serialsToRevert.length} serials: ${serialsToRevert.join(', ')}`);

//             for (const serialNumber of serialsToRevert) {
//               const serial = outletStock.serialNumbers.find(
//                 (sn) => sn.serialNumber === serialNumber
//               );

//               if (serial && serial.status === "in_transit") {
//                 serial.status = "available";
//                 serial.currentLocation = stockRequest.warehouse;

//                 if (serial.transferHistory.length > 0) {
//                   const lastTransfer = serial.transferHistory[serial.transferHistory.length - 1];
//                   if (lastTransfer.status === "in_transit") {
//                     serial.transferHistory.pop();
//                   }
//                 }

//                 console.log(`    Reverted serial ${serialNumber} back to available`);
//               }
//             }

//             outletStock.availableQuantity += quantityToRevert;
//             outletStock.inTransitQuantity -= quantityToRevert;
//           }

//           if (receivedQuantity > 0) {
//             const serialsToTransfer = productItem.approvedSerials.slice(0, receivedQuantity);
            
//             console.log(`  Transferring ${serialsToTransfer.length} serials: ${serialsToTransfer.join(', ')}`);

//             for (const serialNumber of serialsToTransfer) {
//               const serial = outletStock.serialNumbers.find(
//                 (sn) => sn.serialNumber === serialNumber
//               );

//               if (serial && serial.status === "in_transit") {
//                 serial.status = "transferred";
//                 serial.currentLocation = stockRequest.center;

//                 const lastTransfer = serial.transferHistory[serial.transferHistory.length - 1];
//                 if (lastTransfer) {
//                   lastTransfer.status = "completed";
//                   lastTransfer.completedAt = new Date();
//                 }

//                 console.log(`    Marked serial ${serialNumber} as transferred`);
//               }
//             }

//             outletStock.inTransitQuantity -= receivedQuantity;
//             outletStock.totalQuantity -= receivedQuantity;

//             if (receivedQuantity > 0) {
//               await CenterStock.updateStock(
//                 stockRequest.center,
//                 receipt.productId,
//                 receivedQuantity,
//                 serialsToTransfer,
//                 stockRequest.warehouse,
//                 "inbound_transfer"
//               );
//             }

//             productItem.transferredSerials = serialsToTransfer;
//           } else {
//             productItem.transferredSerials = [];
//           }
//         }
//       } else {

//         console.log(`  Processing non-serialized product`);
        
//         if (quantityToRevert > 0) {
//           console.log(`  Reverting ${quantityToRevert} units back to available`);
//           outletStock.availableQuantity += quantityToRevert;
//           outletStock.inTransitQuantity -= quantityToRevert;
//         }

//         if (receivedQuantity > 0) {
//           console.log(`  Transferring ${receivedQuantity} units to center`);
          
//           outletStock.totalQuantity -= receivedQuantity;
//           outletStock.inTransitQuantity -= receivedQuantity;

//           await CenterStock.updateStock(
//             stockRequest.center,
//             receipt.productId,
//             receivedQuantity,
//             [],
//             stockRequest.warehouse,
//             "inbound_transfer"
//           );
          
//           console.log(`  Added ${receivedQuantity} units to center stock`);
//         }
//       }

//       await outletStock.save();
      
//       console.log(`  Outlet stock after: Total=${outletStock.totalQuantity}, Available=${outletStock.availableQuantity}, InTransit=${outletStock.inTransitQuantity}`);

//       productItem.receivedQuantity = receivedQuantity;
//       productItem.receivedRemark = receipt.receivedRemark || "";
      
//       if (productApprovals && productApprovals.length > 0) {
//         const approval = productApprovals.find(
//           (pa) => pa.productId.toString() === receipt.productId.toString()
//         );
//         if (approval) {
//           productItem.approvedQuantity = approval.approvedQuantity;
//           productItem.approvedSerials = approval.approvedSerials || [];
//         }
//       }
//     }
//     if (productApprovals && productApprovals.length > 0) {
//       stockRequest.products = stockRequest.products.map((productItem) => {
//         const approval = productApprovals.find(
//           (pa) => pa.productId.toString() === productItem.product.toString()
//         );

//         if (approval) {
//           return {
//             ...productItem.toObject(),
//             approvedQuantity: approval.approvedQuantity,
//             approvedRemark: approval.approvedRemark || "",
//             approvedSerials: approval.approvedSerials || [],
//           };
//         }
//         return productItem;
//       });
//     }

//     stockRequest.status = "Completed";
//     stockRequest.receivingInfo = {
//       receivedAt: new Date(),
//       receivedBy: userId,
//     };
//     stockRequest.completionInfo = {
//       completedOn: new Date(),
//       completedBy: userId,
//     };
//     stockRequest.updatedBy = userId;

//     const updatedRequest = await stockRequest.save();

//     const populatedRequest = await StockRequest.findById(updatedRequest._id)
//       .populate("warehouse", "_id centerName centerCode centerType")
//       .populate("center", "_id centerName centerCode centerType")
//       .populate("products.product", "_id productTitle productCode productImage")
//       .populate("createdBy", "_id fullName email")
//       .populate("updatedBy", "_id fullName email")
//       .populate("approvalInfo.approvedBy", "_id fullName email")
//       .populate("receivingInfo.receivedBy", "_id fullName email")
//       .populate("completionInfo.completedBy", "_id fullName email");

//     res.status(200).json({
//       success: true,
//       message:
//         "Incomplete stock request completed successfully and stock transferred to center",
//       data: populatedRequest,
//     });
//   } catch (error) {
//     if (error.name === "CastError") {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid stock request ID",
//       });
//     }

//     if (error.name === "ValidationError") {
//       const errors = Object.values(error.errors).map((err) => err.message);
//       return res.status(400).json({
//         success: false,
//         message: "Validation error",
//         errors,
//       });
//     }

//     if (
//       error.message.includes("Insufficient stock") ||
//       error.message.includes("serial numbers") ||
//       error.message.includes("No serial numbers assigned") ||
//       error.message.includes("Approved quantity") ||
//       error.message.includes("Received quantity") ||
//       error.message.includes("Product ID") ||
//       error.message.includes("exceed") ||
//       error.message.includes("Cannot read properties of undefined")
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "Validation failed",
//         error: error.message,
//       });
//     }

//     console.error("Error completing incomplete stock request:", error);
//     res.status(500).json({
//       success: false,
//       message: "Error completing incomplete stock request",
//       error:
//         process.env.NODE_ENV === "development"
//           ? error.message
//           : "Internal server error",
//     });
//   }
// };


// export const completeIncompleteRequest = async (req, res) => {
//   try {
//     const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
//       req,
//       ["manage_indent"]
//     );

//     if (!hasAccess) {
//       return res.status(403).json({
//         success: false,
//         message: "Access denied. manage_indent permission required.",
//       });
//     }

//     const { id } = req.params;
//     const { productApprovals, productReceipts } = req.body;

//     const stockRequest = await StockRequest.findById(id);
//     if (!stockRequest) {
//       return res.status(404).json({
//         success: false,
//         message: "Stock request not found",
//       });
//     }

//     if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
//       return res.status(403).json({
//         success: false,
//         message:
//           "Access denied. You can only complete incomplete stock requests from your own center.",
//       });
//     }

//     if (stockRequest.status !== "Incompleted") {
//       return res.status(400).json({
//         success: false,
//         message: "Only incomplete stock requests can be completed",
//       });
//     }

//     const userId = req.user?.id;
//     if (!userId) {
//       return res.status(400).json({
//         success: false,
//         message: "User authentication required",
//       });
//     }

//     if (
//       (!productApprovals ||
//         !Array.isArray(productApprovals) ||
//         productApprovals.length === 0) &&
//       (!productReceipts ||
//         !Array.isArray(productReceipts) ||
//         productReceipts.length === 0)
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "Either product approvals or product receipts are required",
//       });
//     }

//     const Product = mongoose.model("Product");

//     // MODIFIED: Allow approved quantity to exceed original requested quantity for incomplete completion
//     if (productApprovals && productApprovals.length > 0) {
//       for (const approval of productApprovals) {
//         if (!approval.productId) {
//           return res.status(400).json({
//             success: false,
//             message: "Product ID is required for each product approval",
//           });
//         }

//         if (
//           approval.approvedQuantity === undefined ||
//           approval.approvedQuantity === null
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity is required for product ${approval.productId}`,
//           });
//         }

//         if (
//           typeof approval.approvedQuantity !== "number" ||
//           isNaN(approval.approvedQuantity)
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity must be a valid number for product ${approval.productId}`,
//           });
//         }

//         if (approval.approvedQuantity < 0) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity cannot be negative for product ${approval.productId}`,
//           });
//         }

//         if (!Number.isInteger(approval.approvedQuantity)) {
//           return res.status(400).json({
//             success: false,
//             message: `Approved quantity must be an integer for product ${approval.productId}`,
//           });
//         }

//         const productItem = stockRequest.products.find(
//           (p) => p.product.toString() === approval.productId.toString()
//         );

//         if (!productItem) {
//           return res.status(400).json({
//             success: false,
//             message: `Product ${approval.productId} not found in stock request`,
//           });
//         }

//         // MODIFIED: For incomplete completion, allow approved quantity to exceed requested quantity
//         // This handles cases where more was received than originally approved
//         if (approval.approvedQuantity > productItem.quantity) {
//           console.log(`[DEBUG] Approved quantity (${approval.approvedQuantity}) exceeds requested quantity (${productItem.quantity}) for product ${approval.productId}. Allowed for incomplete completion.`);
//           // Don't throw error - allow it for incomplete completion
//         }

//         if (
//           approval.approvedQuantity === 0 &&
//           (!approval.approvedRemark || approval.approvedRemark.trim() === "")
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Approval remark is required when approved quantity is zero for product ${approval.productId}`,
//           });
//         }

//         const productDoc = await Product.findById(approval.productId);
//         const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";

//         if (tracksSerialNumbers) {
//           if (approval.approvedQuantity > 0) {
//             const approvedSerials = approval.approvedSerials || [];

//             if (approvedSerials.length > 0) {
//               const uniqueSerials = new Set(approvedSerials);
//               if (uniqueSerials.size !== approvedSerials.length) {
//                 return res.status(400).json({
//                   success: false,
//                   message: `Duplicate serial numbers found for product ${productDoc.productTitle}`,
//                 });
//               }
//             }
//           } else {
//             if (
//               approval.approvedSerials &&
//               approval.approvedSerials.length > 0
//             ) {
//               return res.status(400).json({
//                 success: false,
//                 message: `Approved serial numbers should not be provided when approved quantity is zero for product ${productDoc.productTitle}`,
//               });
//             }
//           }
//         } else {
//           if (approval.approvedSerials && approval.approvedSerials.length > 0) {
//             return res.status(400).json({
//               success: false,
//               message: `Approved serial numbers should not be provided for product ${productDoc.productTitle} as it does not track serial numbers`,
//             });
//           }
//         }
//       }

//       const productApprovalsWithQuantity = productApprovals.filter(
//         (pa) => pa.approvedQuantity > 0
//       );

//       if (productApprovalsWithQuantity.length > 0) {
//         const validationResults = await stockRequest.validateSerialNumbersForIncomplete(
//           productApprovalsWithQuantity
//         );
//         const invalidResults = validationResults.filter(
//           (result) => !result.valid
//         );

//         if (invalidResults.length > 0) {
//           return res.status(400).json({
//             success: false,
//             message: "Serial number validation failed",
//             validationErrors: invalidResults,
//           });
//         }
//       }
//     }

//     // MODIFIED: Remove or modify the received quantity > approved quantity check
//     if (productReceipts && productReceipts.length > 0) {
//       for (const receipt of productReceipts) {
//         if (!receipt.productId) {
//           return res.status(400).json({
//             success: false,
//             message: "Product ID is required for each product receipt",
//           });
//         }

//         if (
//           receipt.receivedQuantity === undefined ||
//           receipt.receivedQuantity === null
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity is required for product ${receipt.productId}`,
//           });
//         }

//         if (
//           typeof receipt.receivedQuantity !== "number" ||
//           isNaN(receipt.receivedQuantity)
//         ) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity must be a valid number for product ${receipt.productId}`,
//           });
//         }

//         if (receipt.receivedQuantity < 0) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity cannot be negative for product ${receipt.productId}`,
//           });
//         }

//         if (!Number.isInteger(receipt.receivedQuantity)) {
//           return res.status(400).json({
//             success: false,
//             message: `Received quantity must be an integer for product ${receipt.productId}`,
//           });
//         }

//         const productItem = stockRequest.products.find(
//           (p) => p.product.toString() === receipt.productId.toString()
//         );

//         if (!productItem) {
//           return res.status(400).json({
//             success: false,
//             message: `Product ${receipt.productId} not found in stock request`,
//           });
//         }

//         let currentApprovedQuantity = productItem.approvedQuantity;

//         if (productApprovals && productApprovals.length > 0) {
//           const approval = productApprovals.find(
//             (pa) => pa.productId.toString() === receipt.productId.toString()
//           );
//           if (approval) {
//             currentApprovedQuantity = approval.approvedQuantity;
//           }
//         }

//         // MODIFIED: Don't check if received quantity exceeds approved quantity
//         // This allows completing with the quantity that was marked as received during incomplete
//         console.log(`[DEBUG] Received quantity: ${receipt.receivedQuantity}, Current approved: ${currentApprovedQuantity}`);
        
//         // Optional: You can add a warning but not an error
//         if (receipt.receivedQuantity > currentApprovedQuantity) {
//           console.log(`[WARNING] Received quantity (${receipt.receivedQuantity}) exceeds approved quantity (${currentApprovedQuantity}) for product ${receipt.productId}. Proceeding anyway.`);
//         }
//       }
//     }

//     const OutletStock = mongoose.model("OutletStock");
//     const CenterStock = mongoose.model("CenterStock");

//     // Use productReceipts if provided, otherwise use productApprovals
//     const productsToProcess = productReceipts && productReceipts.length > 0 
//       ? productReceipts 
//       : productApprovals.map((approval) => ({
//           productId: approval.productId,
//           receivedQuantity: approval.approvedQuantity,
//           receivedRemark: approval.receivedRemark || approval.approvedRemark || "",
//         }));

//     for (const receipt of productsToProcess) {
//       const productItem = stockRequest.products.find(
//         (p) => p.product.toString() === receipt.productId.toString()
//       );

//       if (!productItem) {
//         return res.status(400).json({
//           success: false,
//           message: `Product ${receipt.productId} not found in stock request`,
//         });
//       }

//       const productDoc = await Product.findById(receipt.productId);
//       const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";
      
//       const currentApprovedQuantity = productItem.approvedQuantity || 0;
//       const receivedQuantity = receipt.receivedQuantity || 0;
      
//       const outletStock = await OutletStock.findOne({
//         outlet: stockRequest.warehouse,
//         product: receipt.productId,
//       });

//       if (!outletStock) {
//         return res.status(400).json({
//           success: false,
//           message: `No stock found in outlet for product ${receipt.productId}`,
//         });
//       }

//       // Calculate the DIFFERENCE between new approved quantity and current approved quantity
//       let newApprovedQuantity = currentApprovedQuantity;
//       if (productApprovals && productApprovals.length > 0) {
//         const approval = productApprovals.find(
//           pa => pa.productId.toString() === receipt.productId.toString()
//         );
//         if (approval) {
//           newApprovedQuantity = approval.approvedQuantity;
//         }
//       }
      
//       const quantityDifference = newApprovedQuantity - currentApprovedQuantity;
//       const quantityToTransfer = receivedQuantity;
      
//       console.log(`[DEBUG] Processing product ${receipt.productId}:`);
//       console.log(`[DEBUG] Current approved: ${currentApprovedQuantity}`);
//       console.log(`[DEBUG] New approved: ${newApprovedQuantity}`);
//       console.log(`[DEBUG] Quantity difference: ${quantityDifference}`);
//       console.log(`[DEBUG] Received/Transfer quantity: ${quantityToTransfer}`);
//       console.log(`[DEBUG] Outlet stock before - Available: ${outletStock.availableQuantity}, InTransit: ${outletStock.inTransitQuantity}, Total: ${outletStock.totalQuantity}`);

//       if (tracksSerialNumbers) {
//         // Handle serialized products
//         const currentApprovedSerials = productItem.approvedSerials || [];
//         let newApprovedSerials = currentApprovedSerials;
        
//         if (productApprovals && productApprovals.length > 0) {
//           const approval = productApprovals.find(
//             pa => pa.productId.toString() === receipt.productId.toString()
//           );
//           if (approval && approval.approvedSerials) {
//             newApprovedSerials = approval.approvedSerials;
//           }
//         }
        
//         console.log(`[DEBUG] Current approved serials: ${currentApprovedSerials.length}`);
//         console.log(`[DEBUG] New approved serials: ${newApprovedSerials.length}`);

//         // If increasing approved quantity (quantityDifference > 0)
//         if (quantityDifference > 0) {
//           console.log(`[DEBUG] Need to mark ${quantityDifference} additional serials as in_transit`);
          
//           // Get additional serials (the ones beyond current approved)
//           const additionalSerials = newApprovedSerials.slice(currentApprovedQuantity);
          
//           if (additionalSerials.length !== quantityDifference) {
//             return res.status(400).json({
//               success: false,
//               message: `Need ${quantityDifference} additional serial numbers but got ${additionalSerials.length}`,
//             });
//           }
          
//           // Mark additional serials as in_transit
//           let newlyMarkedCount = 0;
//           for (const serialNumber of additionalSerials) {
//             const serial = outletStock.serialNumbers.find(
//               sn => sn.serialNumber === serialNumber
//             );

//             if (serial && serial.status === "available") {
//               serial.status = "in_transit";
//               serial.currentLocation = stockRequest.warehouse;

//               serial.transferHistory.push({
//                 fromCenter: stockRequest.warehouse,
//                 toCenter: stockRequest.center,
//                 transferDate: new Date(),
//                 transferType: "outlet_to_center",
//                 status: "in_transit",
//                 remark: "Additional stock for incomplete completion",
//               });

//               newlyMarkedCount++;
//               console.log(`[DEBUG] Marked additional serial ${serialNumber} as in_transit`);
//             } else if (serial && serial.status === "in_transit") {
//               // Already in transit (from previous incomplete marking)
//               console.log(`[DEBUG] Serial ${serialNumber} already in_transit`);
//               newlyMarkedCount++;
//             }
//           }
          
//           if (newlyMarkedCount > 0) {
//             outletStock.availableQuantity -= newlyMarkedCount;
//             outletStock.inTransitQuantity += newlyMarkedCount;
//             console.log(`[DEBUG] Updated outlet - Available: -${newlyMarkedCount}, InTransit: +${newlyMarkedCount}`);
//           }
//         }
        
//         // If decreasing approved quantity (quantityDifference < 0)
//         if (quantityDifference < 0) {
//           const quantityToRevert = Math.abs(quantityDifference);
//           console.log(`[DEBUG] Need to revert ${quantityToRevert} serials back to available`);
          
//           // Get serials to revert (the ones beyond new approved quantity)
//           const serialsToRevert = currentApprovedSerials.slice(newApprovedQuantity);
          
//           let revertedCount = 0;
//           for (const serialNumber of serialsToRevert) {
//             const serial = outletStock.serialNumbers.find(
//               sn => sn.serialNumber === serialNumber
//             );

//             if (serial && serial.status === "in_transit") {
//               serial.status = "available";
//               serial.currentLocation = stockRequest.warehouse;

//               // Remove the transfer history entry
//               if (serial.transferHistory.length > 0) {
//                 const lastTransfer = serial.transferHistory[serial.transferHistory.length - 1];
//                 if (lastTransfer.status === "in_transit") {
//                   serial.transferHistory.pop();
//                 }
//               }

//               revertedCount++;
//               console.log(`[DEBUG] Reverted serial ${serialNumber} back to available`);
//             }
//           }
          
//           if (revertedCount > 0) {
//             outletStock.availableQuantity += revertedCount;
//             outletStock.inTransitQuantity -= revertedCount;
//             console.log(`[DEBUG] Updated outlet - Available: +${revertedCount}, InTransit: -${revertedCount}`);
//           }
//         }

//         // Now transfer the received quantity
//         if (quantityToTransfer > 0) {
//           const serialsToTransfer = newApprovedSerials.slice(0, quantityToTransfer);
//           console.log(`[DEBUG] Transferring ${serialsToTransfer.length} serials: ${serialsToTransfer.join(', ')}`);

//           let transferredCount = 0;
//           for (const serialNumber of serialsToTransfer) {
//             const serial = outletStock.serialNumbers.find(
//               sn => sn.serialNumber === serialNumber
//             );

//             if (serial && serial.status === "in_transit") {
//               serial.status = "transferred";
//               serial.currentLocation = stockRequest.center;

//               // Update the last transfer history entry
//               if (serial.transferHistory.length > 0) {
//                 const lastTransfer = serial.transferHistory[serial.transferHistory.length - 1];
//                 if (lastTransfer) {
//                   lastTransfer.status = "completed";
//                   lastTransfer.completedAt = new Date();
//                 }
//               }

//               transferredCount++;
//               console.log(`[DEBUG] Marked serial ${serialNumber} as transferred`);
//             }
//           }

//           if (transferredCount > 0) {
//             outletStock.inTransitQuantity -= transferredCount;
//             outletStock.totalQuantity -= transferredCount;

//             // Add to center stock
//             await CenterStock.updateStock(
//               stockRequest.center,
//               receipt.productId,
//               transferredCount,
//               serialsToTransfer,
//               stockRequest.warehouse,
//               "inbound_transfer"
//             );

//             console.log(`[DEBUG] Transferred ${transferredCount} serials to center`);
//           }

//           productItem.transferredSerials = serialsToTransfer;
//         }

//       } else {
//         // Handle non-serialized products
//         console.log(`[DEBUG] Processing non-serialized product`);
        
//         // If increasing approved quantity
//         if (quantityDifference > 0) {
//           console.log(`[DEBUG] Need to mark ${quantityDifference} additional units as in_transit`);
          
//           // Check availability
//           if (outletStock.availableQuantity < quantityDifference) {
//             return res.status(400).json({
//               success: false,
//               message: `Insufficient stock in outlet. Available: ${outletStock.availableQuantity}, Needed: ${quantityDifference}`,
//             });
//           }
          
//           outletStock.availableQuantity -= quantityDifference;
//           outletStock.inTransitQuantity += quantityDifference;
//           console.log(`[DEBUG] Updated outlet - Available: -${quantityDifference}, InTransit: +${quantityDifference}`);
//         }
        
//         // If decreasing approved quantity
//         if (quantityDifference < 0) {
//           const quantityToRevert = Math.abs(quantityDifference);
//           console.log(`[DEBUG] Need to revert ${quantityToRevert} units back to available`);
          
//           outletStock.availableQuantity += quantityToRevert;
//           outletStock.inTransitQuantity -= quantityToRevert;
//           console.log(`[DEBUG] Updated outlet - Available: +${quantityToRevert}, InTransit: -${quantityToRevert}`);
//         }

//         // Transfer the received quantity
//         if (quantityToTransfer > 0) {
//           console.log(`[DEBUG] Transferring ${quantityToTransfer} units to center`);
          
//           outletStock.inTransitQuantity -= quantityToTransfer;
//           outletStock.totalQuantity -= quantityToTransfer;

//           // Add to center stock
//           await CenterStock.updateStock(
//             stockRequest.center,
//             receipt.productId,
//             quantityToTransfer,
//             [],
//             stockRequest.warehouse,
//             "inbound_transfer"
//           );
          
//           console.log(`[DEBUG] Added ${quantityToTransfer} units to center stock`);
//         }
//       }

//       await outletStock.save();
      
//       console.log(`[DEBUG] Outlet stock after - Available: ${outletStock.availableQuantity}, InTransit: ${outletStock.inTransitQuantity}, Total: ${outletStock.totalQuantity}`);

//       // Update product item
//       productItem.receivedQuantity = quantityToTransfer;
//       productItem.receivedRemark = receipt.receivedRemark || "";
      
//       if (productApprovals && productApprovals.length > 0) {
//         const approval = productApprovals.find(
//           (pa) => pa.productId.toString() === receipt.productId.toString()
//         );
//         if (approval) {
//           productItem.approvedQuantity = approval.approvedQuantity;
//           productItem.approvedSerials = approval.approvedSerials || [];
//         }
//       }
//     }

//     // Update stock request with new approvals
//     if (productApprovals && productApprovals.length > 0) {
//       stockRequest.products = stockRequest.products.map((productItem) => {
//         const approval = productApprovals.find(
//           (pa) => pa.productId.toString() === productItem.product.toString()
//         );

//         if (approval) {
//           return {
//             ...productItem.toObject(),
//             approvedQuantity: approval.approvedQuantity,
//             approvedRemark: approval.approvedRemark || "",
//             approvedSerials: approval.approvedSerials || [],
//           };
//         }
//         return productItem;
//       });
//     }

//     stockRequest.status = "Completed";
//     stockRequest.receivingInfo = {
//       receivedAt: new Date(),
//       receivedBy: userId,
//     };
//     stockRequest.completionInfo = {
//       completedOn: new Date(),
//       completedBy: userId,
//     };
//     stockRequest.updatedBy = userId;

//     const updatedRequest = await stockRequest.save();

//     const populatedRequest = await StockRequest.findById(updatedRequest._id)
//       .populate("warehouse", "_id centerName centerCode centerType")
//       .populate("center", "_id centerName centerCode centerType")
//       .populate("products.product", "_id productTitle productCode productImage")
//       .populate("createdBy", "_id fullName email")
//       .populate("updatedBy", "_id fullName email")
//       .populate("approvalInfo.approvedBy", "_id fullName email")
//       .populate("receivingInfo.receivedBy", "_id fullName email")
//       .populate("completionInfo.completedBy", "_id fullName email");

//     res.status(200).json({
//       success: true,
//       message:
//         "Incomplete stock request completed successfully and stock transferred to center",
//       data: populatedRequest,
//     });
//   } catch (error) {
//     console.error("Error completing incomplete stock request:", error);

//     if (error.name === "CastError") {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid stock request ID",
//       });
//     }

//     if (error.name === "ValidationError") {
//       const errors = Object.values(error.errors).map((err) => err.message);
//       return res.status(400).json({
//         success: false,
//         message: "Validation error",
//         errors,
//       });
//     }

//     if (
//       error.message.includes("Insufficient stock") ||
//       error.message.includes("serial numbers") ||
//       error.message.includes("No serial numbers assigned") ||
//       error.message.includes("Approved quantity") ||
//       error.message.includes("Received quantity") ||
//       error.message.includes("Product ID") ||
//       error.message.includes("exceed") ||
//       error.message.includes("Cannot read properties of undefined")
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: "Validation failed",
//         error: error.message,
//       });
//     }

//     res.status(500).json({
//       success: false,
//       message: "Error completing incomplete stock request",
//       error:
//         process.env.NODE_ENV === "development"
//           ? error.message
//           : "Internal server error",
//     });
//   }
// };


///***************************** In below if outlet stock is not presnt then getting isssue then resolve this in below (change approved qty is 0 and not present in outlet stock) */

export const completeIncompleteRequest = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["manage_indent"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. manage_indent permission required.",
      });
    }

    const { id } = req.params;
    const { productApprovals, productReceipts } = req.body;

    console.log("\n🔥🔥🔥 ========== COMPLETE INCOMPLETE REQUEST ========== 🔥🔥🔥");
    console.log(`📅 Time: ${new Date().toISOString()}`);
    console.log(`🆔 Request ID: ${id}`);
    console.log(`📦 productApprovals:`, JSON.stringify(productApprovals, null, 2));
    console.log("🔥🔥🔥 ===================================================== 🔥🔥🔥\n");

    const stockRequest = await StockRequest.findById(id)
      .populate("center", "reseller")
      .populate("warehouse", "_id");

    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message: "Access denied",
      });
    }

    if (stockRequest.status !== "Incompleted") {
      return res.status(400).json({
        success: false,
        message: "Only incomplete stock requests can be completed",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    if ((!productApprovals || productApprovals.length === 0)) {
      return res.status(400).json({
        success: false,
        message: "Product approvals are required",
      });
    }

    const Product = mongoose.model("Product");
    const ResellerStock = mongoose.model("ResellerStock");
    const OutletStock = mongoose.model("OutletStock");
    const CenterStock = mongoose.model("CenterStock");

    const resellerId = stockRequest.center?.reseller?._id;

    // ============================================================
    // SIMPLE VALIDATION: Check if trying to add extra quantity
    // ============================================================
    for (const approval of productApprovals) {
      const productItem = stockRequest.products.find(
        (p) => p.product.toString() === approval.productId.toString()
      );
      
      if (!productItem) {
        return res.status(400).json({
          success: false,
          message: `Product ${approval.productId} not found in stock request`,
        });
      }
      
      const sourceTotal = (productItem.sourceBreakdown?.fromReseller?.quantity || 0) + 
                          (productItem.sourceBreakdown?.fromOutlet?.quantity || 0);
      
      if (approval.approvedQuantity > sourceTotal) {
        console.log(`❌ VALIDATION FAILED: Product ${approval.productId}`);
        console.log(`   Requested: ${approval.approvedQuantity}`);
        console.log(`   Available in source breakdown: ${sourceTotal}`);
        
        return res.status(400).json({
          success: false,
          message: `Cannot approve ${approval.approvedQuantity} units. Only ${sourceTotal} units were originally approved.`,
          requested: approval.approvedQuantity,
          maxAllowed: sourceTotal,
          productId: approval.productId,
        });
      }
      
      console.log(`✅ VALIDATION PASSED: Product ${approval.productId}`);
    }

    // ============================================================
    // PROCESS EACH PRODUCT
    // ============================================================
    for (const approval of productApprovals) {
      const productId = approval.productId;
      const newApprovedQuantity = approval.approvedQuantity;
      const approvedRemark = approval.approvedRemark || "";
      const approvedSerials = approval.approvedSerials || [];
      
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📦 PROCESSING PRODUCT: ${productId}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      
      const productItem = stockRequest.products.find(
        (p) => p.product.toString() === productId.toString()
      );
      
      if (!productItem) {
        console.log(`❌ Product not found, skipping`);
        continue;
      }
      
      const currentApprovedQuantity = productItem.approvedQuantity || 0;
      const quantityToTransfer = newApprovedQuantity;
      
      console.log(`📊 Current Approved: ${currentApprovedQuantity}`);
      console.log(`📊 New Approved: ${newApprovedQuantity}`);
      console.log(`📊 Quantity to Transfer: ${quantityToTransfer}`);
      
      const productDoc = await Product.findById(productId);
      if (!productDoc) {
        console.log(`❌ Product document not found`);
        continue;
      }
      
      const tracksSerialNumbers = productDoc.trackSerialNumber === "Yes";
      const sourceBreakdown = productItem.sourceBreakdown || {
        fromReseller: { quantity: 0, serials: [] },
        fromOutlet: { quantity: 0, serials: [] },
        totalApproved: currentApprovedQuantity
      };
      
      console.log(`💰 Source - Reseller: ${sourceBreakdown.fromReseller.quantity}, Outlet: ${sourceBreakdown.fromOutlet.quantity}`);
      
      let fromResellerTransfer = sourceBreakdown.fromReseller.quantity;
      let fromOutletTransfer = sourceBreakdown.fromOutlet.quantity;
      
      console.log(`📊 Distribution - Reseller: ${fromResellerTransfer}, Outlet: ${fromOutletTransfer}`);
      
      // ============================================================
      // 1. HANDLE RESELLER STOCK - DEDUCT FROM AVAILABLE
      // ============================================================
      if (fromResellerTransfer > 0 && resellerId) {
        console.log(`\n🟣 RESELLER STOCK UPDATE`);
        
        const resellerStock = await ResellerStock.findOne({
          reseller: resellerId,
          product: productId,
        });

        if (!resellerStock) {
          return res.status(400).json({
            success: false,
            message: `Reseller stock not found for product ${productDoc.productTitle}`,
          });
        }

        console.log(`   BEFORE - Available: ${resellerStock.availableQuantity}, Consumed: ${resellerStock.consumedQuantity}`);
        
        if (tracksSerialNumbers) {
          const resellerSerials = sourceBreakdown.fromReseller.serials || [];
          const serialsToTransfer = resellerSerials.slice(0, fromResellerTransfer);
          
          for (const serialNumber of serialsToTransfer) {
            const serial = resellerStock.serialNumbers.find(sn => sn.serialNumber === serialNumber);
            if (serial && serial.status === "available") {
              serial.status = "consumed";
              serial.consumedDate = new Date();
              serial.consumedBy = userId;
              serial.currentLocation = stockRequest.center;
              serial.transferHistory.push({
                fromCenter: null,
                toCenter: stockRequest.center,
                transferDate: new Date(),
                transferType: "outbound_transfer",
                remark: "Incomplete request completion",
                transferredBy: userId,
                referenceId: stockRequest._id,
              });
              console.log(`     ✅ Serial ${serialNumber} consumed from RESELLER available stock`);
            }
          }
        }
        
        resellerStock.availableQuantity -= fromResellerTransfer;
        resellerStock.consumedQuantity += fromResellerTransfer;
        await resellerStock.save();
        
        console.log(`   AFTER - Available: ${resellerStock.availableQuantity}, Consumed: ${resellerStock.consumedQuantity}`);
        console.log(`   ✅ Deducted ${fromResellerTransfer} units from RESELLER AVAILABLE stock`);
      }
      
      // ============================================================
      // 2. HANDLE OUTLET STOCK - ONLY DEDUCT FROM AVAILABLE (NOT in_transit)
      // ============================================================
      if (fromOutletTransfer > 0) {
        console.log(`\n🟠 OUTLET STOCK UPDATE - DEDUCTING FROM AVAILABLE ONLY`);
        
        const outletStock = await OutletStock.findOne({
          outlet: stockRequest.warehouse,
          product: productId,
        });

        if (!outletStock) {
          return res.status(400).json({
            success: false,
            message: `Outlet stock not found for product ${productDoc.productTitle}`,
          });
        }

        console.log(`   BEFORE - Available: ${outletStock.availableQuantity}, InTransit: ${outletStock.inTransitQuantity}, Total: ${outletStock.totalQuantity}`);
        
        if (tracksSerialNumbers) {
          // Serialized products - mark serials as transferred from available
          const outletSerials = sourceBreakdown.fromOutlet.serials || [];
          const serialsToTransfer = outletSerials.slice(0, fromOutletTransfer);
          
          for (const serialNumber of serialsToTransfer) {
            const serial = outletStock.serialNumbers.find(sn => sn.serialNumber === serialNumber);
            if (serial) {
              // Directly mark as transferred (they were restored to available during incomplete)
              serial.status = "transferred";
              serial.currentLocation = stockRequest.center;
              serial.transferredDate = new Date();
              
              serial.transferHistory.push({
                fromCenter: stockRequest.warehouse,
                toCenter: stockRequest.center,
                transferDate: new Date(),
                transferType: "outlet_to_center",
                status: "completed",
                remark: "Incomplete request completion - final transfer",
                transferredBy: userId,
                referenceId: stockRequest._id,
              });
              console.log(`     ✅ Serial ${serialNumber} transferred from OUTLET available stock`);
            }
          }
          
          // Deduct ONLY from available stock (not from in_transit)
          outletStock.availableQuantity -= fromOutletTransfer;
          outletStock.totalQuantity -= fromOutletTransfer;
          
          console.log(`     ✅ Deducted ${fromOutletTransfer} units from OUTLET AVAILABLE stock`);
        } else {
          // Non-serialized products - deduct ONLY from available stock
          console.log(`   📍 Non-Serialized: Need to transfer ${fromOutletTransfer} units`);
          
          if (outletStock.availableQuantity < fromOutletTransfer) {
            console.log(`   ❌ Insufficient available stock!`);
            return res.status(400).json({
              success: false,
              message: `Insufficient outlet available stock. Available: ${outletStock.availableQuantity}, Required: ${fromOutletTransfer}`,
            });
          }
          
          // Deduct ONLY from available stock
          outletStock.availableQuantity -= fromOutletTransfer;
          outletStock.totalQuantity -= fromOutletTransfer;
          
          console.log(`     ✅ Deducted ${fromOutletTransfer} units from OUTLET AVAILABLE stock`);
          console.log(`     (in_transit stock remains unchanged: ${outletStock.inTransitQuantity})`);
        }
        
        await outletStock.save();
        console.log(`   AFTER - Available: ${outletStock.availableQuantity}, InTransit: ${outletStock.inTransitQuantity}, Total: ${outletStock.totalQuantity}`);
      }
      
      // ============================================================
      // 3. ADD TO CENTER STOCK
      // ============================================================
      if (quantityToTransfer > 0) {
        console.log(`\n🟢 CENTER STOCK UPDATE`);
        
        let centerStock = await CenterStock.findOne({
          center: stockRequest.center,
          product: productId,
        });

        if (!centerStock) {
          centerStock = new CenterStock({
            center: stockRequest.center,
            product: productId,
            totalQuantity: 0,
            availableQuantity: 0,
            inTransitQuantity: 0,
            consumedQuantity: 0,
            serialNumbers: [],
          });
          console.log(`   📍 Created new center stock`);
        }

        console.log(`   BEFORE - Total: ${centerStock.totalQuantity}, Available: ${centerStock.availableQuantity}`);
        
        if (tracksSerialNumbers) {
          const resellerSerials = sourceBreakdown.fromReseller.serials || [];
          const outletSerials = sourceBreakdown.fromOutlet.serials || [];
          const serialsToAdd = [
            ...resellerSerials.slice(0, fromResellerTransfer),
            ...outletSerials.slice(0, fromOutletTransfer)
          ];
          
          for (const serialNumber of serialsToAdd) {
            const exists = centerStock.serialNumbers.some(sn => sn.serialNumber === serialNumber);
            if (!exists) {
              centerStock.serialNumbers.push({
                serialNumber: serialNumber,
                purchaseId: new mongoose.Types.ObjectId(),
                originalOutlet: stockRequest.warehouse,
                status: "available",
                currentLocation: stockRequest.center,
                transferHistory: [{
                  fromCenter: stockRequest.warehouse,
                  toCenter: stockRequest.center,
                  transferDate: new Date(),
                  transferType: "inbound_transfer",
                  remark: "Incomplete request completion",
                  referenceId: stockRequest._id,
                  transferredBy: userId,
                }],
              });
              centerStock.totalQuantity += 1;
              centerStock.availableQuantity += 1;
              console.log(`     ✅ Added serial ${serialNumber} to CENTER`);
            }
          }
        } else {
          centerStock.totalQuantity += quantityToTransfer;
          centerStock.availableQuantity += quantityToTransfer;
          console.log(`     ✅ Added ${quantityToTransfer} units to CENTER`);
        }
        
        await centerStock.save();
        console.log(`   AFTER - Total: ${centerStock.totalQuantity}, Available: ${centerStock.availableQuantity}`);
      }
      
      // Update product item
      productItem.approvedQuantity = newApprovedQuantity;
      productItem.approvedRemark = approvedRemark;
      if (tracksSerialNumbers) productItem.approvedSerials = approvedSerials;
      productItem.receivedQuantity = quantityToTransfer;
      
      console.log(`✅ Product ${productDoc.productTitle} completed!`);
    }
    
    // Update stock request status
    stockRequest.status = "Completed";
    stockRequest.receivingInfo = {
      receivedAt: new Date(),
      receivedBy: userId,
      receivedRemark: "Completed from incomplete request",
    };
    stockRequest.completionInfo = {
      completedOn: new Date(),
      completedBy: userId,
    };
    stockRequest.updatedBy = userId;

    const updatedRequest = await stockRequest.save();

    const populatedRequest = await StockRequest.findById(updatedRequest._id)
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode centerType")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email")
      .populate("approvalInfo.approvedBy", "_id fullName email")
      .populate("receivingInfo.receivedBy", "_id fullName email")
      .populate("completionInfo.completedBy", "_id fullName email");

    console.log("\n✅✅✅ INCOMPLETE REQUEST COMPLETED SUCCESSFULLY! ✅✅✅\n");

    res.status(200).json({
      success: true,
      message: "Incomplete stock request completed successfully",
      data: populatedRequest,
    });
    
  } catch (error) {
    console.error("\n🔴 ERROR:", error.message);
    res.status(500).json({
      success: false,
      message: "Error completing incomplete stock request",
      error: error.message,
    });
  }
};

/////************ resolve change approved qty and complete request issue */

export const completeStockRequest = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["complete_indent", "manage_indent"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. complete_indent or manage_indent permission required.",
      });
    }

    const { id } = req.params;
    const { productReceipts, receivedRemark } = req.body;

    console.log(`[DEBUG] =========================================`);
    console.log(`[DEBUG] Completing stock request: ${id}`);
    console.log(`[DEBUG] Raw productReceipts from body:`, JSON.stringify(productReceipts, null, 2));
    console.log(`[DEBUG] =========================================`);

    const stockRequest = await StockRequest.findById(id);
    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    console.log(`[DEBUG] Stock request status: ${stockRequest.status}`);
    console.log(`[DEBUG] Stock request products before completion:`);
    stockRequest.products.forEach((p, idx) => {
      console.log(`[DEBUG]   Product ${idx + 1}:`);
      console.log(`[DEBUG]     - Product ID: ${p.product}`);
      console.log(`[DEBUG]     - Approved Quantity: ${p.approvedQuantity}`);
      console.log(`[DEBUG]     - Source Breakdown:`, JSON.stringify(p.sourceBreakdown, null, 2));
      if (p.approvedSerials && p.approvedSerials.length > 0) {
        console.log(`[DEBUG]     - Approved Serials: ${p.approvedSerials.join(', ')}`);
      }
    });

    if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only complete stock requests from your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    if (
      !productReceipts ||
      !Array.isArray(productReceipts) ||
      productReceipts.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Product receipts are required",
      });
    }

    const Product = mongoose.model("Product");
    const ResellerStock = mongoose.model("ResellerStock");
    const OutletStock = mongoose.model("OutletStock");
    const CenterStock = mongoose.model("CenterStock");

    // ============================================================
    // PRE-FETCH: Cache productDoc + tracksSerialNumbers for each
    // receipt so we use the SAME data in both validation and processing
    // ============================================================
    const productDocCache = new Map(); // productId (string) -> { productDoc, tracksSerialNumbers }

    for (const receipt of productReceipts) {
      if (!receipt.productId) continue;
      const key = receipt.productId.toString();
      if (!productDocCache.has(key)) {
        const productDoc = await Product.findById(receipt.productId);
        const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";
        productDocCache.set(key, { productDoc, tracksSerialNumbers });
        console.log(`[DEBUG] Cached product doc for ${key}: trackSerialNumber="${productDoc?.trackSerialNumber}", tracksSerialNumbers=${tracksSerialNumbers}`);
      }
    }

    // ============================================================
    // VALIDATION LOOP
    // ============================================================
    for (const receipt of productReceipts) {
      if (!receipt.productId) {
        return res.status(400).json({
          success: false,
          message: "Product ID is required for each product receipt",
        });
      }

      if (
        receipt.receivedQuantity === undefined ||
        receipt.receivedQuantity === null
      ) {
        return res.status(400).json({
          success: false,
          message: `Received quantity is required for product ${receipt.productId}`,
        });
      }

      if (
        typeof receipt.receivedQuantity !== "number" ||
        isNaN(receipt.receivedQuantity)
      ) {
        return res.status(400).json({
          success: false,
          message: `Received quantity must be a valid number for product ${receipt.productId}`,
        });
      }

      if (receipt.receivedQuantity < 0) {
        return res.status(400).json({
          success: false,
          message: `Received quantity cannot be negative for product ${receipt.productId}`,
        });
      }

      if (!Number.isInteger(receipt.receivedQuantity)) {
        return res.status(400).json({
          success: false,
          message: `Received quantity must be an integer for product ${receipt.productId}`,
        });
      }

      const productItem = stockRequest.products.find(
        (p) => p.product.toString() === receipt.productId.toString()
      );

      if (!productItem) {
        return res.status(400).json({
          success: false,
          message: `Product ${receipt.productId} not found in stock request`,
        });
      }

      // ✅ SKIP validation for products with 0 approved quantity
      if (productItem.approvedQuantity === 0) {
        console.log(`[DEBUG] Skipping validation for product ${receipt.productId} - approved quantity is 0`);
        
        if (receipt.receivedQuantity > 0) {
          return res.status(400).json({
            success: false,
            message: `Cannot receive ${receipt.receivedQuantity} units for product ${receipt.productId} because approved quantity is 0.`,
          });
        }
        continue;
      }

      if (receipt.receivedQuantity > productItem.approvedQuantity) {
        return res.status(400).json({
          success: false,
          message: `❌ Received quantity (${receipt.receivedQuantity}) CANNOT exceed approved quantity (${productItem.approvedQuantity}) for product ${receipt.productId}`,
        });
      }

      // ============================================================
      // ADDED VALIDATION: Check if user is trying to complete with zero receipt
      // when approved quantity is greater than 0
      // ============================================================
      if (receipt.receivedQuantity === 0 && productItem.approvedQuantity > 0) {
        return res.status(400).json({
          success: false,
          message: `❌ Cannot mark as COMPLETED with 0 received quantity for product ${receipt.productId}. Approved quantity is ${productItem.approvedQuantity}. Please receive the items or use INCOMPLETE endpoint.`,
        });
      }

      // Use cached doc (no second DB call)
      const { productDoc, tracksSerialNumbers } = productDocCache.get(receipt.productId.toString());

      console.log(`[DEBUG][VALIDATION] Product ${receipt.productId}:`);
      console.log(`[DEBUG][VALIDATION]   tracksSerialNumbers=${tracksSerialNumbers}`);
      console.log(`[DEBUG][VALIDATION]   receivedQuantity=${receipt.receivedQuantity}`);
      console.log(`[DEBUG][VALIDATION]   receivedSerials type=${typeof receipt.receivedSerials}, value=`, JSON.stringify(receipt.receivedSerials));

      if (tracksSerialNumbers) {
        // Auto-assign serials if not provided in request
        if (!receipt.receivedSerials || receipt.receivedSerials.length === 0) {
          // Get approved serials from stock request
          const stockProductItem = stockRequest.products.find(
            (p) => p.product.toString() === receipt.productId.toString()
          );
          
          if (stockProductItem && stockProductItem.approvedSerials && stockProductItem.approvedSerials.length > 0) {
            // Auto-assign based on received quantity
            if (receipt.receivedQuantity === stockProductItem.approvedQuantity) {
              receipt.receivedSerials = [...stockProductItem.approvedSerials];
              console.log(`[DEBUG][AUTO-ASSIGN] Auto-assigned all ${receipt.receivedSerials.length} serials for product ${receipt.productId}`);
            } 
            else if (receipt.receivedQuantity < stockProductItem.approvedQuantity) {
              receipt.receivedSerials = stockProductItem.approvedSerials.slice(0, receipt.receivedQuantity);
              console.log(`[DEBUG][AUTO-ASSIGN] Auto-assigned ${receipt.receivedSerials.length} serials (partial) for product ${receipt.productId}`);
            }
            else {
              return res.status(400).json({
                success: false,
                message: `Received quantity (${receipt.receivedQuantity}) cannot exceed approved quantity (${stockProductItem.approvedQuantity}) for product ${productDoc.productTitle}`,
              });
            }
          } else {
            return res.status(400).json({
              success: false,
              message: `No approved serials found for product ${productDoc.productTitle}. Cannot auto-assign.`,
            });
          }
        }

        // Normalise: treat null/undefined as empty array
        const receivedSerials = Array.isArray(receipt.receivedSerials)
          ? receipt.receivedSerials
          : [];

        if (receipt.receivedQuantity > 0) {
          if (receivedSerials.length !== receipt.receivedQuantity) {
            return res.status(400).json({
              success: false,
              message: `Number of received serials (${receivedSerials.length}) must match received quantity (${receipt.receivedQuantity}) for product ${productDoc.productTitle}`,
            });
          }

          if (receivedSerials.length > 0) {
            const uniqueSerials = new Set(receivedSerials);
            if (uniqueSerials.size !== receivedSerials.length) {
              return res.status(400).json({
                success: false,
                message: `Duplicate serial numbers found for product ${productDoc.productTitle}`,
              });
            }
          }
        } else {
          if (receivedSerials.length > 0) {
            return res.status(400).json({
              success: false,
              message: `Received serial numbers should not be provided when received quantity is zero for product ${productDoc.productTitle}`,
            });
          }
        }
      } else {
        if (receipt.receivedSerials && receipt.receivedSerials.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Received serial numbers should not be provided for product ${productDoc.productTitle} as it does not track serial numbers`,
          });
        }
      }
    }

    // ============================================================
    // PROCESSING LOOP
    // ============================================================
    for (const receipt of productReceipts) {
      const productItem = stockRequest.products.find(
        (p) => p.product.toString() === receipt.productId.toString()
      );

      if (!productItem) {
        return res.status(400).json({
          success: false,
          message: `Product ${receipt.productId} not found in stock request`,
        });
      }

      // ✅ SKIP processing for products with 0 approved quantity
      if (productItem.approvedQuantity === 0) {
        console.log(`[DEBUG] Skipping processing for product ${receipt.productId} - approved quantity is 0`);
        continue;
      }

      // Use cached doc (same reference as validation — no inconsistency possible)
      const { productDoc, tracksSerialNumbers } = productDocCache.get(receipt.productId.toString());

      // Get source breakdown from product item
      const sourceBreakdown = productItem.sourceBreakdown || {
        fromReseller: { quantity: 0, serials: [] },
        fromOutlet: { quantity: 0, serials: [] },
        totalApproved: productItem.approvedQuantity || 0
      };

      const totalApproved = sourceBreakdown.totalApproved || productItem.approvedQuantity || 0;
      const receivedCount = receipt.receivedQuantity;

      // Normalise receivedSerials once — same logic as validation
      const receivedSerialsFromBody = Array.isArray(receipt.receivedSerials)
        ? receipt.receivedSerials
        : [];

      console.log(`\n[DEBUG] =========================================`);
      console.log(`[DEBUG] Processing product: ${receipt.productId}`);
      console.log(`[DEBUG] =========================================`);
      console.log(`[DEBUG] tracksSerialNumbers: ${tracksSerialNumbers}`);
      console.log(`[DEBUG] Total approved: ${totalApproved}`);
      console.log(`[DEBUG] Received count: ${receivedCount}`);
      console.log(`[DEBUG] receivedSerialsFromBody (${receivedSerialsFromBody.length}): ${receivedSerialsFromBody.join(', ') || 'none'}`);
      console.log(`[DEBUG] Source breakdown:`);
      console.log(`[DEBUG]   - From Reseller: ${sourceBreakdown.fromReseller.quantity} units${sourceBreakdown.fromReseller.serials?.length > 0 ? ` (${sourceBreakdown.fromReseller.serials.length} serials)` : ''}`);
      console.log(`[DEBUG]   - From Outlet: ${sourceBreakdown.fromOutlet.quantity} units${sourceBreakdown.fromOutlet.serials?.length > 0 ? ` (${sourceBreakdown.fromOutlet.serials.length} serials)` : ''}`);

      let fromResellerReceived = 0;
      let fromOutletReceived = 0;
      let serialsToReceive = [];
      let serialsToReturn = [];

      if (tracksSerialNumbers) {
        console.log(`[DEBUG] Product tracks serial numbers - using serialized distribution logic`);

        const allApprovedSerials = [
          ...(sourceBreakdown.fromReseller.serials || []),
          ...(sourceBreakdown.fromOutlet.serials || [])
        ];
        console.log(`[DEBUG] All approved serials (${allApprovedSerials.length}): ${allApprovedSerials.join(', ')}`);

        if (receivedCount === 0) {
          serialsToReceive = [];
          serialsToReturn = [...allApprovedSerials];
          fromResellerReceived = 0;
          fromOutletReceived = 0;

          console.log(`[DEBUG] Zero receipt - returning all ${serialsToReturn.length} serials`);
        } else {
          // Use the normalised array — guaranteed to match receivedCount (validated above)
          serialsToReceive = receivedSerialsFromBody;

          console.log(`[DEBUG] serialsToReceive (${serialsToReceive.length}): ${serialsToReceive.join(', ')}`);

          // Validate that all received serials are from approved list
          const invalidSerials = serialsToReceive.filter(
            (serial) => !allApprovedSerials.includes(serial)
          );
          if (invalidSerials.length > 0) {
            return res.status(400).json({
              success: false,
              message: `Invalid serial numbers received: ${invalidSerials.join(', ')}. These were not approved for this request.`,
            });
          }

          fromResellerReceived = serialsToReceive.filter((serial) =>
            sourceBreakdown.fromReseller.serials?.includes(serial)
          ).length;
          fromOutletReceived = serialsToReceive.filter((serial) =>
            sourceBreakdown.fromOutlet.serials?.includes(serial)
          ).length;

          serialsToReturn = allApprovedSerials.filter(
            (serial) => !serialsToReceive.includes(serial)
          );

          console.log(`[DEBUG] Serialized distribution:`);
          console.log(`[DEBUG]   - Received from Reseller: ${fromResellerReceived}`);
          console.log(`[DEBUG]   - Received from Outlet: ${fromOutletReceived}`);
          console.log(`[DEBUG]   - Returning: ${serialsToReturn.length} serials (${serialsToReturn.join(', ') || 'none'})`);
        }
      } else {
        console.log(`[DEBUG] Product does NOT track serial numbers - using quantity-based distribution`);

        const resellerRatio =
          totalApproved > 0
            ? sourceBreakdown.fromReseller.quantity / totalApproved
            : 0;
        fromResellerReceived = Math.round(receivedCount * resellerRatio);
        fromOutletReceived = receivedCount - fromResellerReceived;

        fromResellerReceived = Math.min(
          fromResellerReceived,
          sourceBreakdown.fromReseller.quantity
        );
        fromOutletReceived = Math.min(
          fromOutletReceived,
          sourceBreakdown.fromOutlet.quantity
        );

        let totalFromSources = fromResellerReceived + fromOutletReceived;
        if (totalFromSources !== receivedCount && totalFromSources < receivedCount) {
          const difference = receivedCount - totalFromSources;
          if (
            sourceBreakdown.fromOutlet.quantity - fromOutletReceived >= difference
          ) {
            fromOutletReceived += difference;
          } else if (
            sourceBreakdown.fromReseller.quantity - fromResellerReceived >=
            difference
          ) {
            fromResellerReceived += difference;
          }
        }

        console.log(`[DEBUG] Quantity-based distribution:`);
        console.log(`[DEBUG]   - From Reseller: ${fromResellerReceived} units`);
        console.log(`[DEBUG]   - From Outlet: ${fromOutletReceived} units`);
      }

      // ============================================
      // 1. HANDLE OUTLET STOCK UPDATES
      // ============================================
      if (sourceBreakdown.fromOutlet.quantity > 0) {
        const outletStock = await OutletStock.findOne({
          outlet: stockRequest.warehouse,
          product: receipt.productId,
        });

        if (!outletStock) {
          return res.status(400).json({
            success: false,
            message: `No stock found in outlet for product ${receipt.productId}`,
          });
        }

        console.log(`\n[DEBUG] --- Outlet Stock Updates ---`);
        console.log(`[DEBUG] Before update:`);
        console.log(`[DEBUG]   Available: ${outletStock.availableQuantity}`);
        console.log(`[DEBUG]   InTransit: ${outletStock.inTransitQuantity}`);
        console.log(`[DEBUG]   Total: ${outletStock.totalQuantity}`);

        const outletSerials = sourceBreakdown.fromOutlet.serials || [];

        if (tracksSerialNumbers && outletSerials.length > 0) {
          // A. Handle RECEIVED items from outlet
          const receivedOutletSerials = serialsToReceive.filter((serial) =>
            outletSerials.includes(serial)
          );

          let transferredCount = 0;

          if (receivedOutletSerials.length > 0) {
            console.log(`[DEBUG] Marking ${receivedOutletSerials.length} serials as transferred to center`);

            for (const serialNumber of receivedOutletSerials) {
              const serial = outletStock.serialNumbers.find(
                (sn) => sn.serialNumber === serialNumber
              );

              if (serial) {
                console.log(`[DEBUG]     Serial ${serialNumber} status before: ${serial.status}`);
                
                if (serial.status === 'available') {
                  serial.status = 'transferred';
                  serial.currentLocation = stockRequest.center;
                  serial.transferredTo = stockRequest.center;
                  serial.transferDate = new Date();
                  
                  // Add transfer history
                  if (!serial.transferHistory) {
                    serial.transferHistory = [];
                  }
                  serial.transferHistory.push({
                    fromLocation: stockRequest.warehouse,
                    toLocation: stockRequest.center,
                    transferDate: new Date(),
                    transferType: 'outlet_to_center',
                    requestId: stockRequest._id
                  });
                  
                  transferredCount++;
                  console.log(`[DEBUG]     ✓ Serial ${serialNumber} was available, now transferred`);
                } else {
                  console.log(`[DEBUG]     ⚠ Serial ${serialNumber} has unexpected status: ${serial.status}`);
                }
              } else {
                console.log(`[DEBUG]     ❌ Serial ${serialNumber} not found in outlet stock`);
              }
            }
          }

          // B. Handle RETURNED items to outlet
          const returnedOutletSerials = serialsToReturn.filter((serial) =>
            outletSerials.includes(serial)
          );

          let returnedCount = 0;

          if (returnedOutletSerials.length > 0) {
            console.log(`[DEBUG] Returning ${returnedOutletSerials.length} serials back to available stock`);

            for (const serialNumber of returnedOutletSerials) {
              const serial = outletStock.serialNumbers.find(
                (sn) => sn.serialNumber === serialNumber
              );

              if (serial && (serial.status === 'transferred' || serial.status === 'in_transit')) {
                serial.status = 'available';
                serial.currentLocation = stockRequest.warehouse;
                serial.transferredTo = null;
                serial.transferDate = null;
                
                returnedCount++;
                console.log(`[DEBUG]     ✓ Serial ${serialNumber} reverted to available`);
              } else if (serial && serial.status === 'available') {
                console.log(`[DEBUG]     ⚠ Serial ${serialNumber} already available`);
              }
            }
          }

          // ✅ FIX: Properly update quantities for serialized products
          outletStock.availableQuantity = Math.max(0, outletStock.availableQuantity - transferredCount + returnedCount);
          
          // ✅ FIX: Calculate inTransitQuantity correctly - count serials with status 'transferred'
          const actualInTransit = outletStock.serialNumbers.filter(
            sn => sn.status === 'transferred' && 
                  sn.currentLocation?.toString() !== stockRequest.warehouse.toString()
          ).length;
          
          outletStock.inTransitQuantity = actualInTransit;
          
          // ✅ FIX: totalQuantity should equal serialNumbers.length
          outletStock.totalQuantity = outletStock.serialNumbers.length;
          
          console.log(`[DEBUG] After outlet update:`);
          console.log(`[DEBUG]   Available: ${outletStock.availableQuantity} (was ${outletStock.availableQuantity + transferredCount - returnedCount})`);
          console.log(`[DEBUG]   InTransit: ${outletStock.inTransitQuantity} (recalculated from actual transferred serials)`);
          console.log(`[DEBUG]   Total: ${outletStock.totalQuantity} (equals serialNumbers.length)`);
          
        } else {
          // Non-serialized products
          const returnToOutlet = sourceBreakdown.fromOutlet.quantity - fromOutletReceived;

          if (fromOutletReceived > 0) {
            console.log(`[DEBUG] Transferring ${fromOutletReceived} units from outlet to center`);
          }

          // ✅ FIX: For non-serialized, just reduce available and total
          outletStock.availableQuantity = Math.max(0, outletStock.availableQuantity - fromOutletReceived + (returnToOutlet > 0 ? returnToOutlet : 0));
          outletStock.totalQuantity = Math.max(0, outletStock.totalQuantity - fromOutletReceived);
          
          // ✅ FIX: inTransitQuantity should be 0 for non-serialized (no tracking)
          outletStock.inTransitQuantity = 0;

          console.log(`[DEBUG] After outlet update:`);
          console.log(`[DEBUG]   Available: ${outletStock.availableQuantity}`);
          console.log(`[DEBUG]   InTransit: ${outletStock.inTransitQuantity}`);
          console.log(`[DEBUG]   Total: ${outletStock.totalQuantity}`);
        }

        await outletStock.save();
      }

      // ============================================
      // 2. HANDLE RESELLER STOCK UPDATES
      // ============================================
      if (sourceBreakdown.fromReseller.quantity > 0) {
        const resellerId =
          stockRequest.center?.reseller?._id || stockRequest.center?.reseller;
        if (resellerId) {
          const resellerStock = await ResellerStock.findOne({
            reseller: resellerId,
            product: receipt.productId,
          });

          if (resellerStock) {
            console.log(`\n[DEBUG] --- Reseller Stock Updates ---`);
            console.log(`[DEBUG] Before update:`);
            console.log(`[DEBUG]   Available: ${resellerStock.availableQuantity}`);
            console.log(`[DEBUG]   Consumed: ${resellerStock.consumedQuantity}`);

            const resellerSerials = sourceBreakdown.fromReseller.serials || [];

            if (tracksSerialNumbers && resellerSerials.length > 0) {
              const receivedResellerSerials = serialsToReceive.filter(
                (serial) => resellerSerials.includes(serial)
              );

              if (receivedResellerSerials.length > 0) {
                console.log(`[DEBUG] Confirming consumption of ${receivedResellerSerials.length} reseller serials`);

                for (const serialNumber of receivedResellerSerials) {
                  const serial = resellerStock.serialNumbers.find(
                    (sn) => sn.serialNumber === serialNumber
                  );

                  if (serial && serial.status === "available") {
                    serial.status = "consumed";
                    serial.consumedDate = new Date();
                    serial.consumedBy = userId;
                    console.log(`[DEBUG]     ✓ Serial ${serialNumber} marked as consumed`);
                  } else if (serial && serial.status === "consumed") {
                    console.log(`[DEBUG]     ✓ Serial ${serialNumber} already consumed`);
                  }
                }
              }

              const returnedResellerSerials = serialsToReturn.filter(
                (serial) => resellerSerials.includes(serial)
              );

              if (returnedResellerSerials.length > 0) {
                console.log(`[DEBUG] Returning ${returnedResellerSerials.length} reseller serials back to available`);

                for (const serialNumber of returnedResellerSerials) {
                  const serial = resellerStock.serialNumbers.find(
                    (sn) => sn.serialNumber === serialNumber
                  );

                  if (serial && serial.status === "consumed") {
                    serial.status = "available";
                    serial.consumedDate = undefined;
                    serial.consumedBy = undefined;
                    console.log(`[DEBUG]     ✓ Serial ${serialNumber} reverted to available`);
                  } else if (serial && serial.status === "available") {
                    console.log(`[DEBUG]     ✓ Serial ${serialNumber} already available`);
                  }
                }

                resellerStock.availableQuantity += returnedResellerSerials.length;
                resellerStock.consumedQuantity -= returnedResellerSerials.length;
              }
            } else {
              const returnToReseller =
                sourceBreakdown.fromReseller.quantity - fromResellerReceived;

              if (fromResellerReceived > 0) {
                console.log(`[DEBUG] Confirming consumption of ${fromResellerReceived} units from reseller`);
              }

              if (returnToReseller > 0) {
                console.log(`[DEBUG] Returning ${returnToReseller} units back to reseller available stock`);
                resellerStock.availableQuantity += returnToReseller;
                resellerStock.consumedQuantity -= returnToReseller;
              }
            }

            console.log(`[DEBUG] After reseller update:`);
            console.log(`[DEBUG]   Available: ${resellerStock.availableQuantity}`);
            console.log(`[DEBUG]   Consumed: ${resellerStock.consumedQuantity}`);

            await resellerStock.save();
          }
        }
      }

      // ============================================
      // 3. ADD STOCK TO CENTER
      // ============================================
      if (receivedCount > 0) {
        console.log(`\n[DEBUG] --- Center Stock Updates ---`);

        let centerStock = await CenterStock.findOne({
          center: stockRequest.center,
          product: receipt.productId,
        });

        if (!centerStock) {
          centerStock = new CenterStock({
            center: stockRequest.center,
            product: receipt.productId,
            totalQuantity: 0,
            availableQuantity: 0,
            inTransitQuantity: 0,
            consumedQuantity: 0,
            serialNumbers: [],
          });
          console.log(`[DEBUG] Created new center stock record`);
        } else {
          console.log(`[DEBUG] Found existing center stock record`);
          console.log(`[DEBUG]   Before - Total: ${centerStock.totalQuantity}, Available: ${centerStock.availableQuantity}`);
        }

        if (tracksSerialNumbers && serialsToReceive.length > 0) {
          console.log(`[DEBUG] Adding ${serialsToReceive.length} serials to center stock`);

          let addedCount = 0;
          let reactivatedCount = 0;

          for (const serialNumber of serialsToReceive) {
            const existingSerialIndex = centerStock.serialNumbers.findIndex(
              (sn) => sn.serialNumber === serialNumber
            );

            if (existingSerialIndex !== -1) {
              const existingSerial =
                centerStock.serialNumbers[existingSerialIndex];

              if (
                existingSerial.status === "damaged" ||
                existingSerial.status === "damage_pending"
              ) {
                existingSerial.status = "available";
                existingSerial.currentLocation = stockRequest.center;

                existingSerial.transferHistory.push({
                  fromCenter: stockRequest.warehouse,
                  toCenter: stockRequest.center,
                  transferDate: new Date(),
                  transferType: "inbound_transfer",
                  remark: "Stock request completion - reactivated damaged stock",
                  referenceId: stockRequest._id,
                  transferredBy: userId,
                });

                reactivatedCount++;
                centerStock.availableQuantity += 1;
                console.log(`[DEBUG]     ✓ Reactivated damaged serial ${serialNumber}`);
              } else if (existingSerial.status === "available") {
                console.log(`[DEBUG]     ⚠ Serial ${serialNumber} already available in center stock`);
              }
            } else {
              let purchaseId = new mongoose.Types.ObjectId();
              let originalOutlet = stockRequest.warehouse;

              const outletStock = await OutletStock.findOne({
                outlet: stockRequest.warehouse,
                product: receipt.productId,
                "serialNumbers.serialNumber": serialNumber,
              });

              if (outletStock) {
                const outletSerial = outletStock.serialNumbers.find(
                  (sn) => sn.serialNumber === serialNumber
                );
                if (outletSerial && outletSerial.purchaseId) {
                  purchaseId = outletSerial.purchaseId;
                }
                if (outletSerial && outletSerial.originalOutlet) {
                  originalOutlet = outletSerial.originalOutlet;
                }
              }

              centerStock.serialNumbers.push({
                serialNumber: serialNumber,
                purchaseId: purchaseId,
                originalOutlet: originalOutlet,
                status: "available",
                currentLocation: stockRequest.center,
                transferHistory: [
                  {
                    fromCenter: stockRequest.warehouse,
                    toCenter: stockRequest.center,
                    transferDate: new Date(),
                    transferType: "inbound_transfer",
                    remark: "Stock request completion",
                    referenceId: stockRequest._id,
                    transferredBy: userId,
                  },
                ],
              });

              addedCount++;
              centerStock.totalQuantity += 1;
              centerStock.availableQuantity += 1;
              console.log(`[DEBUG]     ✓ Added new serial ${serialNumber}`);
            }
          }

          console.log(`[DEBUG] Summary: Added ${addedCount} new serials, reactivated ${reactivatedCount} damaged serials`);
        } else if (!tracksSerialNumbers && receivedCount > 0) {
          centerStock.totalQuantity += receivedCount;
          centerStock.availableQuantity += receivedCount;
          console.log(`[DEBUG] Added ${receivedCount} non-serialized units to center stock`);
        }

        console.log(`[DEBUG] After center update - Total: ${centerStock.totalQuantity}, Available: ${centerStock.availableQuantity}`);
        await centerStock.save();
      } else {
        console.log(`[DEBUG] No items received, skipping center stock update`);
      }

      // Update product item in stock request
      productItem.receivedQuantity = receipt.receivedQuantity;
      productItem.receivedRemark = receipt.receivedRemark || "";

      if (tracksSerialNumbers && serialsToReceive.length > 0) {
        productItem.transferredSerials = serialsToReceive;
      }

      console.log(`[DEBUG] Product ${receipt.productId} processed successfully`);
      console.log(`[DEBUG]   Received: ${receipt.receivedQuantity}`);
      console.log(`[DEBUG]   From Reseller: ${fromResellerReceived}`);
      console.log(`[DEBUG]   From Outlet: ${fromOutletReceived}`);
      if (tracksSerialNumbers) {
        console.log(`[DEBUG]   Serials received: ${serialsToReceive.join(', ') || 'none'}`);
        console.log(`[DEBUG]   Serials returned: ${serialsToReturn.join(', ') || 'none'}`);
      }
    }

    // Update stock request status
    stockRequest.status = "Completed";
    stockRequest.receivingInfo = {
      receivedAt: new Date(),
      receivedBy: userId,
      receivedRemark: receivedRemark || "",
    };
    stockRequest.completionInfo = {
      completedOn: new Date(),
      completedBy: userId,
    };
    stockRequest.updatedBy = userId;

    const updatedRequest = await stockRequest.save();

    const populatedRequest = await StockRequest.findById(updatedRequest._id)
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode centerType")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate("receivingInfo.receivedBy", "_id fullName email")
      .populate("completionInfo.completedBy", "_id fullName email")
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email");

    console.log(`\n[DEBUG] =========================================`);
    console.log(`[DEBUG] Stock request ${id} completed successfully!`);
    console.log(`[DEBUG] =========================================\n`);

    res.status(200).json({
      success: true,
      message: `Stock request completed successfully. Received ${productReceipts.reduce(
        (sum, r) => sum + r.receivedQuantity,
        0
      )} units.`,
      data: populatedRequest,
    });
  } catch (error) {
    console.error("[ERROR] Error completing stock request:", error);
    console.error("[ERROR] Stack trace:", error.stack);

    if (
      error.message.includes("Insufficient stock") ||
      error.message.includes("serial numbers not available") ||
      error.message.includes("No serial numbers assigned") ||
      error.message.includes("Received quantity") ||
      error.message.includes("Product ID") ||
      error.message.includes("exceed approved quantity") ||
      error.message.includes("Cannot read properties of undefined")
    ) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        error: error.message,
      });
    }
    if (error.message.includes("Path `inTransitQuantity`")) {
      return res.status(400).json({
        success: false,
        message:
          "Stock quantity calculation error. Please check stock levels and try again.",
        error: error.message,
      });
    }
    res.status(500).json({
      success: false,
      message: "Error completing stock request",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};
export const updateStockRequestStatus = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["manage_indent"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. manage_indent permission required.",
      });
    }

    const { id } = req.params;
    const { status, ...additionalInfo } = req.body;

    const stockRequest = await StockRequest.findById(id);
    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only update status for stock requests from your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const updateData = {
      status,
      updatedBy: userId,
    };

    const currentDate = new Date();

    switch (status) {
      case "Confirmed":
        if (additionalInfo.productApprovals) {
          const validationResults = await stockRequest.validateSerialNumbers(
            additionalInfo.productApprovals
          );
          const invalidResults = validationResults.filter(
            (result) => !result.valid
          );

          if (invalidResults.length > 0) {
            return res.status(400).json({
              success: false,
              message: "Serial number validation failed",
              validationErrors: invalidResults,
            });
          }
        }

        updateData.approvalInfo = {
          ...stockRequest.approvalInfo,
          approvedAt: currentDate,
          approvedBy: userId,
          approvedRemark: additionalInfo.approvedRemark || "",
          ...additionalInfo,
        };

        if (additionalInfo.productApprovals) {
          updateData.products = stockRequest.products.map((productItem) => {
            const approval = additionalInfo.productApprovals.find(
              (pa) => pa.productId.toString() === productItem.product.toString()
            );
            if (approval) {
              return {
                ...productItem.toObject(),
                approvedQuantity: approval.approvedQuantity,
                approvedRemark: approval.approvedRemark || "",
                approvedSerials: approval.approvedSerials || [],
              };
            }
            return productItem;
          });
        }
        break;

      case "Completed":
        if (additionalInfo.productReceipts) {
          for (const receipt of additionalInfo.productReceipts) {
            const productItem = stockRequest.products.find(
              (p) => p.product.toString() === receipt.productId.toString()
            );

            if (
              productItem &&
              receipt.receivedQuantity > productItem.approvedQuantity
            ) {
              return res.status(400).json({
                success: false,
                message: `Received quantity (${receipt.receivedQuantity}) cannot exceed approved quantity (${productItem.approvedQuantity})`,
              });
            }
          }
        }

        updateData.receivingInfo = {
          ...stockRequest.receivingInfo,
          receivedAt: currentDate,
          receivedBy: userId,
          receivedRemark: additionalInfo.receivedRemark || "",
          ...additionalInfo,
        };

        updateData.completionInfo = {
          ...stockRequest.completionInfo,
          completedOn: currentDate,
          completedBy: userId,
          ...additionalInfo,
        };

        if (additionalInfo.productReceipts) {
          updateData.products = stockRequest.products.map((productItem) => {
            const receipt = additionalInfo.productReceipts.find(
              (pr) => pr.productId.toString() === productItem.product.toString()
            );
            if (receipt) {
              return {
                ...productItem.toObject(),
                receivedQuantity: receipt.receivedQuantity,
                receivedRemark: receipt.receivedRemark || "",
              };
            }
            return productItem;
          });
        }
        break;
    }

    const updatedRequest = await StockRequest.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate("approvalInfo.approvedBy", "_id fullName email")
      .populate("shippingInfo.shippedBy", "_id fullName email")
      .populate("receivingInfo.receivedBy", "_id fullName email")
      .populate("incompleteInfo.incompleteBy", "_id fullName email")
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message: `Stock request status updated to ${status}`,
      data: updatedRequest,
    });
  } catch (error) {
    console.error("Error updating stock request status:", error);

    if (
      error.message.includes("serial numbers") ||
      error.message.includes("Insufficient stock") ||
      error.message.includes("Received quantity cannot exceed")
    ) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        error: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: "Error updating stock request status",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

// export const updateApprovedQuantities = async (req, res) => {
//   try {
//     const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
//       req,
//       ["manage_indent"]
//     );

//     if (!hasAccess) {
//       return res.status(403).json({
//         success: false,
//         message: "Access denied. manage_indent permission required.",
//       });
//     }

//     const { id } = req.params;
//     const { productApprovals } = req.body;

//     const stockRequest = await StockRequest.findById(id);
//     if (!stockRequest) {
//       return res.status(404).json({
//         success: false,
//         message: "Stock request not found",
//       });
//     }

//     if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
//       return res.status(403).json({
//         success: false,
//         message:
//           "Access denied. You can only update approved quantities for stock requests from your own center.",
//       });
//     }

//     const userId = req.user?.id;
//     if (!userId) {
//       return res.status(400).json({
//         success: false,
//         message: "User authentication required",
//       });
//     }

//     const OutletStock = mongoose.model("OutletStock");
//     const Product = mongoose.model("Product");

//     // Validate product approvals
//     for (const approval of productApprovals) {
//       if (!approval.productId) {
//         return res.status(400).json({
//           success: false,
//           message: "Product ID is required for each product approval",
//         });
//       }

//       const productDoc = await Product.findById(approval.productId);
      
//       // Skip validation if approved quantity is 0 (product is not being approved)
//       if (approval.approvedQuantity === 0) {
//         continue;
//       }

//       const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";

//       if (tracksSerialNumbers && approval.approvedSerials && approval.approvedSerials.length > 0) {
//         const productItem = stockRequest.products.find(
//           (p) => p.product.toString() === approval.productId.toString()
//         );

//         const outletStock = await OutletStock.findOne({
//           outlet: stockRequest.warehouse,
//           product: approval.productId,
//         });

//         if (!outletStock) {
//           return res.status(400).json({
//             success: false,
//             message: `No stock found in outlet for product ${productDoc?.productTitle || approval.productId}`,
//           });
//         }

//         const availableSerials = [];
//         const unavailableSerials = [];

//         for (const serialNumber of approval.approvedSerials) {
//           const serial = outletStock.serialNumbers.find(
//             (sn) => sn.serialNumber === serialNumber
//           );

//           if (serial) {
//             if (serial.status === "available") {
//               availableSerials.push(serialNumber);
//             } else if (serial.status === "in_transit") {
//               const isAssignedToThisTransfer =
//                 productItem?.approvedSerials?.includes(serialNumber);
//               if (isAssignedToThisTransfer) {
//                 availableSerials.push(serialNumber);
//               } else {
//                 unavailableSerials.push(serialNumber);
//               }
//             } else {
//               unavailableSerials.push(serialNumber);
//             }
//           } else {
//             unavailableSerials.push(serialNumber);
//           }
//         }

//         if (unavailableSerials.length > 0) {
//           return res.status(400).json({
//             success: false,
//             message: `Serial numbers not available: ${unavailableSerials.join(", ")}`,
//             productId: approval.productId,
//             productName: productDoc?.productTitle || "Unknown Product",
//           });
//         }
//       }
//     }

//     // Process each product approval
//     for (const approval of productApprovals) {
//       const productItem = stockRequest.products.find(
//         (p) => p.product.toString() === approval.productId.toString()
//       );

//       if (!productItem) {
//         return res.status(400).json({
//           success: false,
//           message: `Product ${approval.productId} not found in stock request`,
//         });
//       }

//       const currentApprovedQuantity = productItem.approvedQuantity || 0;
//       const newApprovedQuantity = approval.approvedQuantity;

//       // SKIP processing if approved quantity is 0
//       // This means the product is not being approved
//       if (newApprovedQuantity === 0) {
//         console.log(`[DEBUG] Skipping product ${approval.productId} - approved quantity is 0`);
//         // If there was previously approved quantity, we need to restore it
//         if (currentApprovedQuantity > 0) {
//           console.log(`[DEBUG] Restoring ${currentApprovedQuantity} units for product ${approval.productId}`);
          
//           const outletStock = await OutletStock.findOne({
//             outlet: stockRequest.warehouse,
//             product: approval.productId,
//           });

//           if (outletStock) {
//             const productDoc = await Product.findById(approval.productId);
//             const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";

//             if (tracksSerialNumbers) {
//               // Restore serial numbers for serialized product
//               const currentApprovedSerials = productItem.approvedSerials || [];
//               console.log(`[DEBUG] Restoring ${currentApprovedSerials.length} serials for product ${approval.productId}`);
              
//               let restoredCount = 0;
//               for (const serialNumber of currentApprovedSerials) {
//                 const serial = outletStock.serialNumbers.find(
//                   (sn) => sn.serialNumber === serialNumber
//                 );

//                 if (serial && serial.status === "in_transit") {
//                   serial.status = "available";
//                   serial.currentLocation = stockRequest.warehouse;
//                   restoredCount++;

//                   // Remove the transfer history for this center
//                   serial.transferHistory = serial.transferHistory.filter(
//                     (history) =>
//                       !(
//                         history.toCenter?.toString() ===
//                         stockRequest.center.toString() &&
//                         history.transferType === "outlet_to_center"
//                       )
//                   );

//                   console.log(`[DEBUG] Restored serial ${serialNumber} to available`);
//                 }
//               }

//               if (restoredCount > 0) {
//                 outletStock.availableQuantity += restoredCount;
//                 outletStock.inTransitQuantity -= restoredCount;
//                 await outletStock.save();
//                 console.log(`[DEBUG] Updated outlet: Available +${restoredCount}, InTransit -${restoredCount}`);
//               }
//             } else {
//               // Restore non-serialized product quantity
//               outletStock.availableQuantity += currentApprovedQuantity;
//               outletStock.inTransitQuantity -= currentApprovedQuantity;
//               await outletStock.save();
//               console.log(`[DEBUG] Restored ${currentApprovedQuantity} units to available stock`);
//             }
//           }
//         }
//         continue; // Skip to next product
//       }

//       const outletStock = await OutletStock.findOne({
//         outlet: stockRequest.warehouse,
//         product: approval.productId,
//       });

//       if (!outletStock) {
//         return res.status(400).json({
//           success: false,
//           message: `No stock found in outlet for product ${approval.productId}`,
//         });
//       }

//       console.log(`[DEBUG] Processing product: ${approval.productId}`);
//       console.log(`[DEBUG] Current approved: ${currentApprovedQuantity}, New approved: ${newApprovedQuantity}`);
//       console.log(`[DEBUG] Outlet stock before - Total: ${outletStock.totalQuantity}, Available: ${outletStock.availableQuantity}, InTransit: ${outletStock.inTransitQuantity}`);

//       const productDoc = await Product.findById(approval.productId);
//       const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";

//       if (tracksSerialNumbers) {
//         // Handle serialized products
//         const currentApprovedSerials = productItem.approvedSerials || [];
//         const newApprovedSerials = approval.approvedSerials || [];

//         if (newApprovedQuantity < currentApprovedQuantity) {
//           console.log(`[DEBUG] Quantity reduced from ${currentApprovedQuantity} to ${newApprovedQuantity}`);
          
//           const quantityToRestore = currentApprovedQuantity - newApprovedQuantity;
//           let serialsToRestore = [];

//           if (JSON.stringify(currentApprovedSerials) !== JSON.stringify(newApprovedSerials)) {
//             serialsToRestore = currentApprovedSerials.filter(
//               (serial) => !newApprovedSerials.includes(serial)
//             );
//             console.log(`[DEBUG] Restoring ${serialsToRestore.length} specific serials`);
//           } else {
//             serialsToRestore = currentApprovedSerials.slice(newApprovedQuantity);
//             console.log(`[DEBUG] Restoring last ${serialsToRestore.length} serials`);
//           }

//           let restoredCount = 0;
//           for (const serialNumber of serialsToRestore) {
//             const serial = outletStock.serialNumbers.find(
//               (sn) => sn.serialNumber === serialNumber
//             );

//             if (serial && serial.status === "in_transit") {
//               serial.status = "available";
//               serial.currentLocation = stockRequest.warehouse;
//               restoredCount++;

//               // Remove the transfer history for this center
//               serial.transferHistory = serial.transferHistory.filter(
//                 (history) =>
//                   !(
//                     history.toCenter?.toString() ===
//                     stockRequest.center.toString() &&
//                     history.transferType === "outlet_to_center"
//                   )
//               );

//               console.log(`[DEBUG] Restored serial ${serialNumber} to available`);
//             }
//           }

//           if (restoredCount > 0) {
//             outletStock.availableQuantity += restoredCount;
//             outletStock.inTransitQuantity -= restoredCount;
//             await outletStock.save();
//             console.log(`[DEBUG] Updated outlet: Available +${restoredCount}, InTransit -${restoredCount}`);
//           }
//         } else if (newApprovedQuantity > currentApprovedQuantity) {
//           console.log(`[DEBUG] Quantity increased from ${currentApprovedQuantity} to ${newApprovedQuantity}`);
          
//           const quantityToAdd = newApprovedQuantity - currentApprovedQuantity;
          
//           if (newApprovedSerials.length < newApprovedQuantity) {
//             return res.status(400).json({
//               success: false,
//               message: `Need ${quantityToAdd} additional serial numbers for quantity increase`,
//               productId: approval.productId,
//               productName: productDoc?.productTitle || "Unknown Product",
//             });
//           }

//           const additionalSerials = newApprovedSerials.slice(currentApprovedQuantity);
          
//           if (additionalSerials.length !== quantityToAdd) {
//             return res.status(400).json({
//               success: false,
//               message: `Need ${quantityToAdd} additional serial numbers but got ${additionalSerials.length}`,
//               productId: approval.productId,
//             });
//           }

//           let newlyMarkedInTransit = 0;
//           for (const serialNumber of additionalSerials) {
//             const serial = outletStock.serialNumbers.find(
//               (sn) => sn.serialNumber === serialNumber
//             );

//             if (serial) {
//               if (serial.status === "available") {
//                 serial.status = "in_transit";
//                 serial.transferHistory.push({
//                   fromCenter: stockRequest.warehouse,
//                   toCenter: stockRequest.center,
//                   transferDate: new Date(),
//                   transferType: "outlet_to_center",
//                   remark: "Added during quantity increase",
//                 });
//                 newlyMarkedInTransit++;
//                 console.log(`[DEBUG] Marked serial ${serialNumber} as in_transit`);
//               } else if (serial.status === "in_transit") {
//                 const existingTransfer = serial.transferHistory.find(
//                   (history) =>
//                     history.toCenter?.toString() ===
//                     stockRequest.center.toString()
//                 );

//                 if (!existingTransfer) {
//                   serial.transferHistory.push({
//                     fromCenter: stockRequest.warehouse,
//                     toCenter: stockRequest.center,
//                     transferDate: new Date(),
//                     transferType: "outlet_to_center",
//                     remark: "Added during quantity increase",
//                   });
//                 }
//                 newlyMarkedInTransit++;
//                 console.log(`[DEBUG] Serial ${serialNumber} already in_transit`);
//               }
//             } else {
//               return res.status(400).json({
//                 success: false,
//                 message: `Serial number ${serialNumber} not found in outlet stock`,
//                 productId: approval.productId,
//               });
//             }
//           }

//           if (newlyMarkedInTransit > 0) {
//             outletStock.availableQuantity -= newlyMarkedInTransit;
//             outletStock.inTransitQuantity += newlyMarkedInTransit;
//             await outletStock.save();
//             console.log(`[DEBUG] Updated outlet: Available -${newlyMarkedInTransit}, InTransit +${newlyMarkedInTransit}`);
//           }
//         } else if (JSON.stringify(currentApprovedSerials) !== JSON.stringify(newApprovedSerials)) {
//           // Same quantity, different serials
//           console.log(`[DEBUG] Same quantity (${currentApprovedQuantity}), different serials`);
          
//           const serialsToRemove = currentApprovedSerials.filter(
//             (serial) => !newApprovedSerials.includes(serial)
//           );
//           const serialsToAdd = newApprovedSerials.filter(
//             (serial) => !currentApprovedSerials.includes(serial)
//           );

//           console.log(`[DEBUG] Serials to remove: ${serialsToRemove.length}, to add: ${serialsToAdd.length}`);

//           // Restore removed serials
//           let restoredCount = 0;
//           for (const serialNumber of serialsToRemove) {
//             const serial = outletStock.serialNumbers.find(
//               (sn) => sn.serialNumber === serialNumber
//             );

//             if (serial && serial.status === "in_transit") {
//               serial.status = "available";
//               serial.currentLocation = stockRequest.warehouse;
//               restoredCount++;

//               serial.transferHistory = serial.transferHistory.filter(
//                 (history) =>
//                   !(
//                     history.toCenter?.toString() ===
//                     stockRequest.center.toString() &&
//                     history.transferType === "outlet_to_center"
//                   )
//               );
//               console.log(`[DEBUG] Restored serial ${serialNumber}`);
//             }
//           }

//           // Mark new serials as in_transit
//           let addedCount = 0;
//           for (const serialNumber of serialsToAdd) {
//             const serial = outletStock.serialNumbers.find(
//               (sn) => sn.serialNumber === serialNumber
//             );

//             if (serial) {
//               if (serial.status === "available") {
//                 serial.status = "in_transit";
//                 serial.transferHistory.push({
//                   fromCenter: stockRequest.warehouse,
//                   toCenter: stockRequest.center,
//                   transferDate: new Date(),
//                   transferType: "outlet_to_center",
//                   remark: "Swapped during serial change",
//                 });
//                 addedCount++;
//                 console.log(`[DEBUG] Marked serial ${serialNumber} as in_transit`);
//               } else if (serial.status === "in_transit") {
//                 const existingTransfer = serial.transferHistory.find(
//                   (history) =>
//                     history.toCenter?.toString() ===
//                     stockRequest.center.toString()
//                 );

//                 if (!existingTransfer) {
//                   serial.transferHistory.push({
//                     fromCenter: stockRequest.warehouse,
//                     toCenter: stockRequest.center,
//                     transferDate: new Date(),
//                     transferType: "outlet_to_center",
//                     remark: "Swapped during serial change",
//                   });
//                 }
//                 addedCount++;
//                 console.log(`[DEBUG] Serial ${serialNumber} already in_transit`);
//               }
//             } else {
//               return res.status(400).json({
//                 success: false,
//                 message: `Serial number ${serialNumber} not found in outlet stock`,
//                 productId: approval.productId,
//               });
//             }
//           }

//           // Update outlet quantities
//           if (restoredCount > 0) {
//             outletStock.availableQuantity += restoredCount;
//             outletStock.inTransitQuantity -= restoredCount;
//           }
//           if (addedCount > 0) {
//             outletStock.availableQuantity -= addedCount;
//             outletStock.inTransitQuantity += addedCount;
//           }

//           if (restoredCount > 0 || addedCount > 0) {
//             await outletStock.save();
//             console.log(`[DEBUG] Updated outlet after serial swap`);
//           }
//         }
//       } else {
//         // Handle non-serialized products
//         console.log(`[DEBUG] Processing non-serialized product`);
        
//         if (newApprovedQuantity < currentApprovedQuantity) {
//           console.log(`[DEBUG] Quantity reduced from ${currentApprovedQuantity} to ${newApprovedQuantity}`);
          
//           const quantityToRestore = currentApprovedQuantity - newApprovedQuantity;
          
//           // Restore unused quantity back to available
//           outletStock.availableQuantity += quantityToRestore;
//           outletStock.inTransitQuantity -= quantityToRestore;
          
//           await outletStock.save();
//           console.log(`[DEBUG] Restored ${quantityToRestore} units: Available +${quantityToRestore}, InTransit -${quantityToRestore}`);
          
//         } else if (newApprovedQuantity > currentApprovedQuantity) {
//           console.log(`[DEBUG] Quantity increased from ${currentApprovedQuantity} to ${newApprovedQuantity}`);
          
//           const quantityToAdd = newApprovedQuantity - currentApprovedQuantity;
          
//           // Check if enough stock is available
//           if (outletStock.availableQuantity < quantityToAdd) {
//             return res.status(400).json({
//               success: false,
//               message: `Insufficient stock in outlet. Required: ${quantityToAdd}, Available: ${outletStock.availableQuantity}`,
//               productId: approval.productId,
//               productName: productDoc?.productTitle || "Unknown Product",
//             });
//           }
          
//           // Mark additional quantity as in_transit
//           outletStock.availableQuantity -= quantityToAdd;
//           outletStock.inTransitQuantity += quantityToAdd;
          
//           await outletStock.save();
//           console.log(`[DEBUG] Added ${quantityToAdd} units: Available -${quantityToAdd}, InTransit +${quantityToAdd}`);
//         }
//       }

//       console.log(`[DEBUG] Outlet stock after - Total: ${outletStock.totalQuantity}, Available: ${outletStock.availableQuantity}, InTransit: ${outletStock.inTransitQuantity}`);
//     }

//     // Update stock request products with new approvals
//     const updatedProducts = stockRequest.products.map((productItem) => {
//       const approval = productApprovals.find(
//         (pa) => pa.productId.toString() === productItem.product.toString()
//       );

//       if (approval) {
//         const updatedItem = {
//           ...productItem.toObject(),
//           approvedQuantity: approval.approvedQuantity,
//         };

//         // Only include approvedSerials for serialized products
//         const productDoc = Product.findById(approval.productId);
//         if (productDoc?.trackSerialNumber === "Yes") {
//           updatedItem.approvedSerials = approval.approvedSerials || [];
//         }

//         return updatedItem;
//       }
//       return productItem;
//     });

//     const updateData = {
//       products: updatedProducts,
//       updatedBy: userId,
//     };

//     // Update status to Confirmed if it's Submitted
//     if (stockRequest.status === "Submitted") {
//       updateData.status = "Confirmed";
//       updateData.approvalInfo = {
//         ...stockRequest.approvalInfo,
//         approvedBy: userId,
//         approvedAt: new Date(),
//       };
//     }

//     const updatedRequest = await StockRequest.findByIdAndUpdate(
//       id,
//       updateData,
//       { new: true, runValidators: true }
//     )
//       .populate("warehouse", "_id centerName centerCode centerType")
//       .populate("center", "_id centerName centerCode")
//       .populate("products.product", "_id productTitle productCode productImage")
//       .populate("createdBy", "_id fullName email")
//       .populate("updatedBy", "_id fullName email")
//       .populate("approvalInfo.approvedBy", "_id fullName email");

//     res.status(200).json({
//       success: true,
//       message: "Approved quantities updated successfully",
//       data: updatedRequest,
//     });
//   } catch (error) {
//     if (error.name === "CastError") {
//       return res.status(400).json({
//         success: false,
//         message: "Invalid stock request ID",
//       });
//     }

//     if (error.name === "ValidationError") {
//       const errors = Object.values(error.errors).map((err) => err.message);
//       return res.status(400).json({
//         success: false,
//         message: "Validation error",
//         errors,
//       });
//     }

//     if (error.message.includes("serial numbers") || error.message.includes("Insufficient stock")) {
//       return res.status(400).json({
//         success: false,
//         message: "Validation failed",
//         error: error.message,
//       });
//     }

//     console.error("Error updating approved quantities:", error);
//     res.status(500).json({
//       success: false,
//       message: "Error updating approved quantities",
//       error:
//         process.env.NODE_ENV === "development"
//           ? error.message
//           : "Internal server error",
//     });
//   }
// };


export const updateApprovedQuantities = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["manage_indent"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. manage_indent permission required.",
      });
    }

    const { id } = req.params;
    const { productApprovals } = req.body;

    const stockRequest = await StockRequest.findById(id)
      .populate("center", "reseller")
      .populate("warehouse", "_id");
    
    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only update approved quantities for stock requests from your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const OutletStock = mongoose.model("OutletStock");
    const ResellerStock = mongoose.model("ResellerStock");
    const Product = mongoose.model("Product");

    const resellerId = stockRequest.center?.reseller?._id;

    for (const approval of productApprovals) {
      const productItem = stockRequest.products.find(
        (p) => p.product.toString() === approval.productId.toString()
      );

      if (!productItem) {
        return res.status(400).json({
          success: false,
          message: `Product ${approval.productId} not found in stock request`,
        });
      }

      const currentApprovedQuantity = productItem.approvedQuantity || 0;
      const newApprovedQuantity = approval.approvedQuantity;
      
      const productDoc = await Product.findById(approval.productId);
      const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";

      console.log(`[DEBUG] Processing product ${approval.productId}:`);
      console.log(`[DEBUG] Current approved: ${currentApprovedQuantity}, New approved: ${newApprovedQuantity}`);

      let newSourceBreakdown = {
        fromReseller: { quantity: 0, serials: [] },
        fromOutlet: { quantity: 0, serials: [] },
        totalApproved: newApprovedQuantity
      };

      if (newApprovedQuantity > 0) {
        let resellerAvailable = 0;
        let outletAvailable = 0;
        let resellerStockDoc = null;
        let outletStockDoc = null;

        if (resellerId) {
          resellerStockDoc = await ResellerStock.findOne({
            reseller: resellerId,
            product: approval.productId,
          });
          if (resellerStockDoc) {
            resellerAvailable = resellerStockDoc.availableQuantity || 0;
          }
        }

        outletStockDoc = await OutletStock.findOne({
          outlet: stockRequest.warehouse,
          product: approval.productId,
        });
        if (outletStockDoc) {
          outletAvailable = outletStockDoc.availableQuantity || 0;
        }

        if (tracksSerialNumbers && approval.approvedSerials && approval.approvedSerials.length > 0) {
      
          const serials = approval.approvedSerials;
        
          if (resellerStockDoc) {
            for (const serialNumber of serials) {
              const serial = resellerStockDoc.serialNumbers.find(
                sn => sn.serialNumber === serialNumber && sn.status === "available"
              );
              if (serial) {
                newSourceBreakdown.fromReseller.serials.push(serialNumber);
              }
            }
          }
          newSourceBreakdown.fromOutlet.serials = serials.filter(
            sn => !newSourceBreakdown.fromReseller.serials.includes(sn)
          );
          
          newSourceBreakdown.fromReseller.quantity = newSourceBreakdown.fromReseller.serials.length;
          newSourceBreakdown.fromOutlet.quantity = newSourceBreakdown.fromOutlet.serials.length;
        } else {

          newSourceBreakdown.fromReseller.quantity = Math.min(newApprovedQuantity, resellerAvailable);
          newSourceBreakdown.fromOutlet.quantity = newApprovedQuantity - newSourceBreakdown.fromReseller.quantity;
        }
        if (newSourceBreakdown.fromReseller.quantity + newSourceBreakdown.fromOutlet.quantity !== newApprovedQuantity) {
          return res.status(400).json({
            success: false,
            message: `Source breakdown calculation error for product ${productDoc?.productTitle}. Expected ${newApprovedQuantity}, got Reseller: ${newSourceBreakdown.fromReseller.quantity}, Outlet: ${newSourceBreakdown.fromOutlet.quantity}`,
          });
        }

        const currentSourceBreakdown = productItem.sourceBreakdown || {
          fromReseller: { quantity: 0, serials: [] },
          fromOutlet: { quantity: 0, serials: [] }
        };

        if (outletStockDoc) {
          const currentOutletQty = currentSourceBreakdown.fromOutlet.quantity;
          const newOutletQty = newSourceBreakdown.fromOutlet.quantity;
          const outletQtyDiff = newOutletQty - currentOutletQty;

          if (outletQtyDiff > 0) {

            if (tracksSerialNumbers) {
              const newOutletSerials = newSourceBreakdown.fromOutlet.serials.filter(
                serial => !currentSourceBreakdown.fromOutlet.serials.includes(serial)
              );
              
              for (const serialNumber of newOutletSerials) {
                const serial = outletStockDoc.serialNumbers.find(
                  sn => sn.serialNumber === serialNumber
                );

                if (serial && serial.status === "available") {
                  serial.status = "in_transit";
                  serial.currentLocation = stockRequest.warehouse;
                  serial.transferHistory.push({
                    fromCenter: stockRequest.warehouse,
                    toCenter: stockRequest.center,
                    transferDate: new Date(),
                    transferType: "outlet_to_center",
                    status: "in_transit",
                  });
                }
              }
            }
            
            outletStockDoc.availableQuantity -= outletQtyDiff;
            outletStockDoc.inTransitQuantity += outletQtyDiff;
          } else if (outletQtyDiff < 0) {

            const outletQtyToRevert = Math.abs(outletQtyDiff);
            
            if (tracksSerialNumbers) {
              const serialsToRevert = currentSourceBreakdown.fromOutlet.serials.filter(
                serial => !newSourceBreakdown.fromOutlet.serials.includes(serial)
              );
              
              for (const serialNumber of serialsToRevert) {
                const serial = outletStockDoc.serialNumbers.find(
                  sn => sn.serialNumber === serialNumber
                );

                if (serial && serial.status === "in_transit") {
                  serial.status = "available";
                  serial.currentLocation = stockRequest.warehouse;

                  if (serial.transferHistory.length > 0) {
                    const lastTransfer = serial.transferHistory[serial.transferHistory.length - 1];
                    if (lastTransfer.status === "in_transit") {
                      serial.transferHistory.pop();
                    }
                  }
                }
              }
            }
            
            outletStockDoc.availableQuantity += outletQtyToRevert;
            outletStockDoc.inTransitQuantity -= outletQtyToRevert;
          }

          await outletStockDoc.save();
        }

        if (resellerStockDoc) {
          const currentResellerQty = currentSourceBreakdown.fromReseller.quantity;
          const newResellerQty = newSourceBreakdown.fromReseller.quantity;
          const resellerQtyDiff = newResellerQty - currentResellerQty;

          if (resellerQtyDiff > 0) {

            if (tracksSerialNumbers) {
              const newResellerSerials = newSourceBreakdown.fromReseller.serials.filter(
                serial => !currentSourceBreakdown.fromReseller.serials.includes(serial)
              );
              
              for (const serialNumber of newResellerSerials) {
                const serial = resellerStockDoc.serialNumbers.find(
                  sn => sn.serialNumber === serialNumber
                );

                if (serial && serial.status === "available") {
                  serial.status = "consumed";
                  serial.consumedDate = new Date();
                  serial.consumedBy = userId;
                  serial.currentLocation = stockRequest.center;
                }
              }
            }
            
            resellerStockDoc.availableQuantity -= resellerQtyDiff;
            resellerStockDoc.consumedQuantity += resellerQtyDiff;
          } else if (resellerQtyDiff < 0) {
            const resellerQtyToRevert = Math.abs(resellerQtyDiff);
            
            if (tracksSerialNumbers) {
              const serialsToRevert = currentSourceBreakdown.fromReseller.serials.filter(
                serial => !newSourceBreakdown.fromReseller.serials.includes(serial)
              );
              
              for (const serialNumber of serialsToRevert) {
                const serial = resellerStockDoc.serialNumbers.find(
                  sn => sn.serialNumber === serialNumber
                );

                if (serial && serial.status === "consumed") {
                  serial.status = "available";
                  serial.consumedDate = null;
                  serial.consumedBy = null;
                  serial.currentLocation = null;
                }
              }
            }
            
            resellerStockDoc.availableQuantity += resellerQtyToRevert;
            resellerStockDoc.consumedQuantity -= resellerQtyToRevert;
          }

          await resellerStockDoc.save();
        }
      } else {
        const currentSourceBreakdown = productItem.sourceBreakdown || {
          fromReseller: { quantity: 0, serials: [] },
          fromOutlet: { quantity: 0, serials: [] }
        };
        if (currentSourceBreakdown.fromOutlet.quantity > 0) {
          const outletStockDoc = await OutletStock.findOne({
            outlet: stockRequest.warehouse,
            product: approval.productId,
          });

          if (outletStockDoc) {
            if (tracksSerialNumbers) {
              for (const serialNumber of currentSourceBreakdown.fromOutlet.serials) {
                const serial = outletStockDoc.serialNumbers.find(
                  sn => sn.serialNumber === serialNumber
                );

                if (serial && serial.status === "in_transit") {
                  serial.status = "available";
                  serial.currentLocation = stockRequest.warehouse;
                  
                  if (serial.transferHistory.length > 0) {
                    const lastTransfer = serial.transferHistory[serial.transferHistory.length - 1];
                    if (lastTransfer.status === "in_transit") {
                      serial.transferHistory.pop();
                    }
                  }
                }
              }
            }
            
            outletStockDoc.availableQuantity += currentSourceBreakdown.fromOutlet.quantity;
            outletStockDoc.inTransitQuantity -= currentSourceBreakdown.fromOutlet.quantity;
            await outletStockDoc.save();
          }
        }
        if (currentSourceBreakdown.fromReseller.quantity > 0 && resellerStockDoc) {
          const resellerStockDoc = await ResellerStock.findOne({
            reseller: resellerId,
            product: approval.productId,
          });

          if (resellerStockDoc) {
            if (tracksSerialNumbers) {
              for (const serialNumber of currentSourceBreakdown.fromReseller.serials) {
                const serial = resellerStockDoc.serialNumbers.find(
                  sn => sn.serialNumber === serialNumber
                );

                if (serial && serial.status === "consumed") {
                  serial.status = "available";
                  serial.consumedDate = null;
                  serial.consumedBy = null;
                  serial.currentLocation = null;
                }
              }
            }
            
            resellerStockDoc.availableQuantity += currentSourceBreakdown.fromReseller.quantity;
            resellerStockDoc.consumedQuantity -= currentSourceBreakdown.fromReseller.quantity;
            await resellerStockDoc.save();
          }
        }
      }

      productItem.sourceBreakdown = newSourceBreakdown;
      productItem.approvedQuantity = newApprovedQuantity;
      productItem.approvedRemark = approval.approvedRemark || "";
      if (tracksSerialNumbers) {
        productItem.approvedSerials = approval.approvedSerials || [];
      }
    }

    if (stockRequest.status === "Submitted") {
      stockRequest.status = "Confirmed";
      stockRequest.approvalInfo = {
        ...stockRequest.approvalInfo,
        approvedBy: userId,
        approvedAt: new Date(),
      };
    }

    stockRequest.updatedBy = userId;
    await stockRequest.save();

    const populatedRequest = await StockRequest.findById(stockRequest._id)
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email")
      .populate("approvalInfo.approvedBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message: "Approved quantities updated successfully",
      data: populatedRequest,
    });
  } catch (error) {
    console.error("Error updating approved quantities:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid stock request ID",
      });
    }

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    if (error.message.includes("serial numbers") || error.message.includes("Insufficient stock")) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        error: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: "Error updating approved quantities",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const getMostRecentOrderNumber = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["indent_all_center", "indent_own_center"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. indent_own_center or indent_all_center permission required.",
      });
    }

    if (
      permissions.indent_own_center &&
      !permissions.indent_all_center &&
      userCenter
    ) {
      const userCenterId = userCenter._id || userCenter;
    }
    const mostRecentRequest = await StockRequest.findOne()
      .sort({ createdAt: -1 })
      .select("orderNumber createdAt")
      .lean();

    if (!mostRecentRequest) {
      return res.status(404).json({
        success: false,
        message: "No stock requests found",
        data: null,
      });
    }

    res.status(200).json({
      success: true,
      message: "Most recent order number retrieved successfully",
      data: {
        orderNumber: mostRecentRequest.orderNumber,
        createdAt: mostRecentRequest.createdAt,
      },
    });
  } catch (error) {
    console.error("Error retrieving most recent order number:", error);
    res.status(500).json({
      success: false,
      message: "Error retrieving most recent order number",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const getCenterSerialNumbers = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["indent_all_center", "indent_own_center"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. indent_own_center or indent_all_center permission required.",
      });
    }

    const { productId } = req.params;

    const user = await User.findById(req.user.id).populate("center");
    if (!user || !user.center) {
      return res.status(400).json({
        success: false,
        message: "User center information not found",
      });
    }

    const centerId = user.center._id;

    if (
      permissions.indent_own_center &&
      !permissions.indent_all_center &&
      userCenter
    ) {
      const userCenterId = userCenter._id || userCenter;
      if (userCenterId.toString() !== centerId.toString()) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied. You can only view serial numbers from your own center.",
        });
      }
    }

    const centerStock = await CenterStock.findOne({
      center: centerId,
      product: productId,
    })
      .populate("center", "centerName centerCode centerType")
      .populate("product", "productTitle productCode trackSerialNumber");

    if (!centerStock) {
      return res.status(200).json({
        success: true,
        message: "No stock found for the specified product",
        data: {
          center: await Center.findById(centerId).select(
            "centerName centerCode centerType"
          ),
          product: await Product.findById(productId).select(
            "productTitle productCode trackSerialNumber"
          ),
          availableSerials: [],
          totalAvailable: 0,
          stockSummary: {
            totalQuantity: 0,
            availableQuantity: 0,
            inTransitQuantity: 0,
            consumedQuantity: 0,
          },
        },
      });
    }

    const availableSerials = centerStock.serialNumbers
      .filter((sn) => sn.status === "available")
      .map((sn) => ({
        serialNumber: sn.serialNumber,
        purchaseId: sn.purchaseId,
        originalOutlet: sn.originalOutlet,
        currentLocation: sn.currentLocation,
        status: sn.status,
      }));

    res.status(200).json({
      success: true,
      message: "Center serial numbers retrieved successfully",
      data: {
        centerStock: {
          _id: centerStock._id,
          center: centerStock.center,
          product: centerStock.product,
          totalQuantity: centerStock.totalQuantity,
          availableQuantity: centerStock.availableQuantity,
          inTransitQuantity: centerStock.inTransitQuantity,
          consumedQuantity: centerStock.consumedQuantity,
          lastUpdated: centerStock.lastUpdated,
        },
        availableSerials,
        totalAvailable: availableSerials.length,
      },
    });
  } catch (error) {
    console.error("Error retrieving center serial numbers:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error retrieving center serial numbers",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const getStockRequestCount = async (req, res) => {
  try {
    const match = {};

    if (req.query.center) {
      match.center = req.query.center;
    }
    if (req.query.warehouse) {
      match.warehouse = req.query.warehouse;
    }
    if (req.query.startDate && req.query.endDate) {
      match.date = {
        $gte: new Date(req.query.startDate),
        $lte: new Date(req.query.endDate),
      };
    }
    const summary = await StockRequest.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
    ]);
    const totalRequests = summary.reduce((acc, cur) => acc + cur.count, 0);

    const completed =
      summary.find((s) => s._id === "Completed")?.count || 0;
    const incomplete =
      summary.find((s) => s._id === "Incompleted")?.count || 0;

    return res.status(200).json({
      success: true,
      totalRequests,
      completed,
      incomplete,
      summary: summary.reduce((acc, s) => {
        acc[s._id] = s.count;
        return acc;
      }, {}),
    });
  } catch (error) {
    console.error("Error fetching stock request summary:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch stock request summary",
      error: error.message,
    });
  }
};

export const getStockRequestNotifications = async (req, res) => {
  try {
    const {
      type,
      center,
      days = 7
    } = req.query;
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    startDate.setHours(0, 0, 0, 0);
    
    const filter = {
      createdAt: { $gte: startDate }
    };
    
    if (center) {
      filter.center = center;
    }
    
    if (type && type !== 'all') {
      switch (type) {
        case 'submitted':
          filter.status = 'Submitted';
          break;
        case 'completed':
          filter.status = 'Completed';
          break;
        case 'confirmed':
          filter.status = 'Confirmed';
          break;
        case 'shipped':
          filter.status = 'Shipped';
          break;
        case 'incompleted':
          filter.status = 'Incompleted';
          break;
      }
    }

    const stockRequests = await StockRequest.find(filter)
      .populate("center", "centerName centerCode")
      .populate("createdBy", "fullName")
      .populate("approvalInfo.approvedBy", "fullName")
      .populate("completionInfo.completedBy", "fullName")
      .populate("incompleteInfo.incompleteBy", "fullName")
      .sort({ createdAt: -1 })
      .lean();

    // Filter out requests with missing center data and format notifications
    const validStockRequests = stockRequests.filter(request => 
      request.center && request.center.centerName
    );

    const notifications = validStockRequests.map(request => {
      return formatStockRequestToNotification(request);
    });

    res.status(200).json({
      success: true,
      message: "Stock request notifications retrieved successfully",
      data: notifications,
      totalCount: notifications.length
    });

  } catch (error) {
    console.error("Error retrieving stock request notifications:", error);
    res.status(500).json({
      success: false,
      message: "Error retrieving notifications",
      error: error.message,
    });
  }
};

const formatStockRequestToNotification = (stockRequest) => {
  const formatDate = (date) => {
    return new Date(date).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  };

  let title = '';
  let message = '';
  let notificationType = '';
  let timestamp = stockRequest.createdAt;

  const centerName = stockRequest.center?.centerName || 'Unknown Center';
  const orderNumber = stockRequest.orderNumber || 'N/A';
  const createdByName = stockRequest.createdBy?.fullName || 'Unknown User';

  switch (stockRequest.status) {
    case 'Submitted':
      notificationType = 'new_request';
      title = 'New Stock Request Submitted';
      message = `New Stock Request No. ${orderNumber} had been Submitted From ${centerName} By ${createdByName} - ${formatDate(stockRequest.createdAt)}`;
      break;

    case 'Completed':
      notificationType = 'request_completed';
      title = 'Stock Request Completed';
      const completedBy = stockRequest.completionInfo?.completedBy?.fullName || 
                         stockRequest.receivingInfo?.receivedBy?.fullName || 
                         'System';
      message = `Your indent Request No. ${orderNumber} had been Completed From ${centerName} By ${completedBy} - ${formatDate(stockRequest.completionInfo?.completedOn || stockRequest.updatedAt)}`;
      timestamp = stockRequest.completionInfo?.completedOn || stockRequest.updatedAt;
      break;

    case 'Confirmed':
      notificationType = 'request_approved';
      title = 'Stock Request Approved';
      const approvedBy = stockRequest.approvalInfo?.approvedBy?.fullName || 'System';
      message = `Stock Request No. ${orderNumber} has been Approved From ${centerName} By ${approvedBy} - ${formatDate(stockRequest.approvalInfo?.approvedAt || stockRequest.updatedAt)}`;
      timestamp = stockRequest.approvalInfo?.approvedAt || stockRequest.updatedAt;
      break;

    case 'Shipped':
      notificationType = 'request_shipped';
      title = 'Stock Request Shipped';
      const shippedBy = stockRequest.shippingInfo?.shippedBy?.fullName || 'System';
      message = `Stock Request No. ${orderNumber} has been Shipped From ${centerName} By ${shippedBy} - ${formatDate(stockRequest.shippingInfo?.shippedAt || stockRequest.updatedAt)}`;
      timestamp = stockRequest.shippingInfo?.shippedAt || stockRequest.updatedAt;
      break;

    case 'Incompleted':
      notificationType = 'request_incompleted';
      title = 'Stock Request Incompleted';
      const incompletedBy = stockRequest.completionInfo?.incompleteBy?.fullName || 'System';
      message = `Stock Request No. ${orderNumber} has been Marked Incomplete From ${centerName} By ${incompletedBy} - ${formatDate(stockRequest.completionInfo?.incompleteOn || stockRequest.updatedAt)}`;
      timestamp = stockRequest.completionInfo?.incompleteOn || stockRequest.updatedAt;
      break;

    case 'Rejected':
      notificationType = 'request_rejected';
      title = 'Stock Request Rejected';
      message = `Stock Request No. ${orderNumber} has been Rejected From ${centerName} - ${formatDate(stockRequest.updatedAt)}`;
      break;

    default:
      notificationType = 'status_updated';
      title = 'Stock Request Updated';
      message = `Stock Request No. ${orderNumber} status updated to ${stockRequest.status} From ${centerName} - ${formatDate(stockRequest.updatedAt)}`;
      timestamp = stockRequest.updatedAt;
  }

  return {
    id: stockRequest._id,
    type: notificationType,
    title,
    message,
    stockRequestId: stockRequest._id,
    orderNumber: stockRequest.orderNumber,
    center: stockRequest.center,
    status: stockRequest.status,
    timestamp,
    createdAt: stockRequest.createdAt,
    isRead: false
  };
};

//Challan Approval
export const updateWarehouseChallanApproval = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["manage_indent", "stock_transfer_approve_from_outlet"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. manage_indent or stock_transfer_approve_from_outlet permission required.",
      });
    }

    const { id } = req.params;
    const {warehouseChallanApproval } = req.body;

    const stockRequest = await StockRequest.findById(id);
    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only update challan approval for stock requests from your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    if (!["pending", "approved", "rejected"].includes(warehouseChallanApproval)) {
      return res.status(400).json({
        success: false,
        message: "Invalid challan approval status. Must be one of: pending, approved, rejected",
      });
    }

    const updateData = {
      warehouseChallanApproval,
      updatedBy: userId,
      approvalInfo: {
        ...stockRequest.approvalInfo,
      },
    };

    if (warehouseChallanApproval === "approved" || warehouseChallanApproval === "rejected") {
      updateData.approvalInfo.warehouseChallanApprovedAt = new Date();
      updateData.approvalInfo.warehouseChallanApprovedBy = userId;

    } else {

      updateData.approvalInfo.warehouseChallanApprovedAt = undefined;
      updateData.approvalInfo.warehouseChallanApprovedBy = undefined;
    }

    const updatedRequest = await StockRequest.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode centerType")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate("approvalInfo.approvedBy", "_id fullName email")
      .populate("approvalInfo.warehouseChallanApprovedBy", "_id fullName email")
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email");
    res.status(200).json({
      success: true,
      message: `Challan approval status updated to ${warehouseChallanApproval} successfully`,
      data: updatedRequest,
    });
  } catch (error) {
    console.error("Error updating challan approval:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid stock request ID",
      });
    }

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    res.status(500).json({
      success: false,
      message: "Error updating challan approval",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const updateCenterChallanApproval = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } = checkStockRequestPermissions(
      req,
      ["manage_indent", "stock_transfer_approve_from_outlet"]
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. manage_indent or stock_transfer_approve_from_outlet permission required.",
      });
    }

    const { id } = req.params;
    const { centerChallanApproval } = req.body;

    const stockRequest = await StockRequest.findById(id);
    if (!stockRequest) {
      return res.status(404).json({
        success: false,
        message: "Stock request not found",
      });
    }

    if (!checkCenterAccess(stockRequest, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only update challan approval for stock requests from your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    if (!["pending", "approved", "rejected"].includes(centerChallanApproval)) {
      return res.status(400).json({
        success: false,
        message: "Invalid challan approval status. Must be one of: pending, approved, rejected",
      });
    }

    const updateData = {
      centerChallanApproval,
      updatedBy: userId,
      approvalInfo: {
        ...stockRequest.approvalInfo,
      },
    };

    if (centerChallanApproval === "approved" || centerChallanApproval === "rejected") {
      updateData.approvalInfo.centerChallanApprovedAt = new Date();
      updateData.approvalInfo.centerChallanApprovedBy = userId;
    } else {

      updateData.approvalInfo.centerChallanApprovedAt = undefined;
      updateData.approvalInfo.centerChallanApprovedBy = undefined;
    }

    const updatedRequest = await StockRequest.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate("warehouse", "_id centerName centerCode centerType")
      .populate("center", "_id centerName centerCode centerType")
      .populate("products.product", "_id productTitle productCode productImage")
      .populate("approvalInfo.approvedBy", "_id fullName email")
      .populate("approvalInfo.centerChallanApprovedBy", "_id fullName email")
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email");

      res.status(200).json({
      success: true,
      message: `Challan approval status updated to ${centerChallanApproval} successfully`,
      data: updatedRequest,
    });
  } catch (error) {
    console.error("Error updating challan approval:", error);

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid stock request ID",
      });
    }

    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    res.status(500).json({
      success: false,
      message: "Error updating challan approval",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    })
  }
};  
