import StockTransfer from "../models/StockTransfer.js";
import Center from "../models/Center.js";
import User from "../models/User.js";
import StockRequest from "../models/StockRequest.js";
import StockPurchase from "../models/StockPurchase.js";
import StockUsage from "../models/StockUsage.js";
import CenterStock from "../models/CenterStock.js";
import Product from "../models/Product.js";
import OutletStock from "../models/OutletStock.js";
import mongoose from "mongoose";

const checkStockTransferPermissions = (req, requiredPermissions = []) => {
  const userPermissions = req.user.role?.permissions || [];
  const transferModule = userPermissions.find(
    (perm) => perm.module === "Transfer"
  );

  if (!transferModule) {
    return { hasAccess: false, permissions: {} };
  }

  const permissions = {
    manage_stock_transfer_all_center: transferModule.permissions.includes(
      "manage_stock_transfer_all_center"
    ),
    manage_stock_transfer_own_center: transferModule.permissions.includes(
      "manage_stock_transfer_own_center"
    ),
    stock_transfer_all_center: transferModule.permissions.includes(
      "stock_transfer_all_center"
    ),
    stock_transfer_own_center: transferModule.permissions.includes(
      "stock_transfer_own_center"
    ),
    delete_transfer_all_center: transferModule.permissions.includes(
      "delete_transfer_all_center"
    ),
    delete_transfer_own_center: transferModule.permissions.includes(
      "delete_transfer_own_center"
    ),
    approval_transfer_center: transferModule.permissions.includes(
      "approval_transfer_center"
    ),
    indent_all_center: transferModule.permissions.includes("indent_all_center"),
    indent_own_center: transferModule.permissions.includes("indent_own_center"),
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

const checkTransferCenterAccess = (stockTransfer, userCenter, permissions) => {
  if (
    permissions.stock_transfer_all_center ||
    permissions.manage_stock_transfer_all_center
  ) {
    return true;
  }

  if (
    (permissions.stock_transfer_own_center ||
      permissions.manage_stock_transfer_own_center) &&
    userCenter
  ) {
    const userCenterId = userCenter._id || userCenter;
    const fromCenterId =
      stockTransfer.fromCenter._id || stockTransfer.fromCenter;
    const toCenterId = stockTransfer.toCenter._id || stockTransfer.toCenter;

    return (
      userCenterId.toString() === fromCenterId.toString() ||
      userCenterId.toString() === toCenterId.toString()
    );
  }

  return false;
};

const validateResellerForTransfer = async (fromCenterId, toCenterId) => {
  try {
    const Center = mongoose.model("Center");
    
    const [fromCenter, toCenter] = await Promise.all([
      Center.findById(fromCenterId).populate("reseller"),
      Center.findById(toCenterId).populate("reseller")
    ]);

    if (!fromCenter || !toCenter) {
      throw new Error("One or both centers not found");
    }

    const isCenterToCenter = 
      fromCenter.centerType === "Center" && 
      toCenter.centerType === "Center";

    if (!isCenterToCenter) {
      return {
        isValid: true,
        requiresValidation: false,
        message: "Reseller validation not required for this transfer type"
      };
    }

    if (!fromCenter.reseller || !toCenter.reseller) {
      throw new Error("Reseller information not found for one or both centers");
    }

    if (fromCenter.reseller._id.toString() !== toCenter.reseller._id.toString()) {
      return {
        isValid: false,
        requiresValidation: true,
        fromCenter: {
          name: fromCenter.centerName,
          type: fromCenter.centerType,
          reseller: fromCenter.reseller.resellerName
        },
        toCenter: {
          name: toCenter.centerName,
          type: toCenter.centerType,
          reseller: toCenter.reseller.resellerName
        }
      };
    }

    return {
      isValid: true,
      requiresValidation: true,
      reseller: fromCenter.reseller.resellerName,
      fromCenterType: fromCenter.centerType,
      toCenterType: toCenter.centerType
    };
  } catch (error) {
    throw new Error(`Reseller validation failed: ${error.message}`);
  }
};


export const createStockTransfer = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const {
      fromCenter,
      transferNumber,
      remark,
      products,
      date,
      status = "Draft",
      productApprovals = [],
    } = req.body;

    if (
      permissions.manage_stock_transfer_own_center &&
      !permissions.manage_stock_transfer_all_center &&
      userCenter
    ) {
      const userCenterId = userCenter._id || userCenter;
      if (fromCenter !== userCenterId.toString()) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied. You can only create transfers from your own center.",
        });
      }
    }

    if (!transferNumber || transferNumber.trim() === "") {
      return res.status(400).json({
        success: false,
        message: "Transfer number is required",
      });
    }

    const validStatuses = ["Draft", "Submitted"];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message:
          'Status must be either "Draft" or "Submitted" when creating a transfer',
      });
    }

    const existingTransfer = await StockTransfer.findOne({
      transferNumber: transferNumber.trim(),
    });

    if (existingTransfer) {
      return res.status(409).json({
        success: false,
        message:
          "Transfer number already exists. Please use a unique transfer number.",
        duplicateTransferNumber: transferNumber.trim(),
        existingTransferId: existingTransfer._id,
      });
    }

    const user = await User.findById(req.user.id).populate("center");
    if (!user || !user.center) {
      return res.status(400).json({
        success: false,
        message: "User center information not found",
      });
    }

    const toCenterId = user.center._id;
    const resellerValidation = await validateResellerForTransfer(fromCenter, toCenterId);
    
    if (!resellerValidation.isValid) {
      return res.status(400).json({
        success: false,
        message: "Stock transfer between Centers is only allowed within the same reseller",
        details: {
          error: `Cannot transfer between Centers of different resellers`,
          fromCenter: resellerValidation.fromCenter,
          toCenter: resellerValidation.toCenter,
          rule: "Center-to-Center transfers require same reseller"
        }
      });
    }

    console.log(`[DEBUG] Transfer: ${resellerValidation.fromCenterType} → ${resellerValidation.toCenterType}`);
    console.log(`[DEBUG] Reseller validation: ${resellerValidation.requiresValidation ? 'Applied' : 'Not required'}`);


    if (
      permissions.manage_stock_transfer_own_center &&
      !permissions.manage_stock_transfer_all_center &&
      userCenter
    ) {
      const userCenterId = userCenter._id || userCenter;
      if (toCenterId.toString() !== userCenterId.toString()) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied. You can only create transfers to your own center.",
        });
      }
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

    let transferDate = new Date();
    if (date) {
      transferDate = new Date(date);
      if (isNaN(transferDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid date format. Please provide a valid date.",
        });
      }
    }

    const stockTransfer = new StockTransfer({
      transferNumber: transferNumber.trim(),
      fromCenter,
      toCenter: toCenterId,
      remark: remark || "",
      products,
      date: transferDate,
      status: status,
      createdBy: req.user.id,
    });

    if (status === "Submitted") {
      try {
        await stockTransfer.validateStockAvailability();

        if (productApprovals && productApprovals.length > 0) {
          const validationResults = await stockTransfer.validateSerialNumbers(
            productApprovals
          );
          const invalidResults = validationResults.filter(
            (result) => !result.valid
          );

          if (invalidResults.length > 0) {
            return res.status(400).json({
              success: false,
              message: `Serial number validation failed: ${invalidResults
                .map((r) => r.error)
                .join(", ")}`,
              validationResults: validationResults,
            });
          }

          stockTransfer.products = stockTransfer.products.map((productItem) => {
            const approval = productApprovals.find(
              (pa) => pa.productId.toString() === productItem.product.toString()
            );

            if (approval) {
              return {
                ...productItem.toObject(),
                approvedQuantity:
                  approval.approvedQuantity || productItem.quantity,
                approvedRemark: approval.approvedRemark || "",
                approvedSerials: approval.approvedSerials || [],
              };
            }
            return productItem;
          });
        } else {
          stockTransfer.products.forEach((product) => {
            product.approvedQuantity = product.quantity;
          });
        }

        await stockTransfer.validateTransferSerialNumbers();
      } catch (validationError) {
        return res.status(400).json({
          success: false,
          message: `Cannot create transfer with Submitted status: ${validationError.message}`,
        });
      }
    }

    const savedStockTransfer = await stockTransfer.save();

    const populatedTransfer = await StockTransfer.findById(
      savedStockTransfer._id
    )
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumbers"
      )
      .populate("createdBy", "_id fullName email");

    res.status(201).json({
      success: true,
      message: `Stock transfer created successfully with status: ${status}`,
      data: populatedTransfer,
    });
  } catch (error) {
    console.error("Error creating stock transfer:", error);

    if (error.code === 11000) {
      const duplicateField = Object.keys(error.keyPattern)[0];
      if (duplicateField === "transferNumber") {
        return res.status(409).json({
          success: false,
          message:
            "Transfer number already exists. Please use a unique transfer number.",
          duplicateTransferNumber: req.body.transferNumber,
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
      message: "Error creating stock transfer",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const submitStockTransfer = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;

    const stockTransfer = await StockTransfer.findById(id);
    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only submit transfers involving your own center.",
      });
    }

    const submittedTransfer = await stockTransfer.submitTransfer();

    const populatedTransfer = await StockTransfer.findById(
      submittedTransfer._id
    )
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumbers"
      )
      .populate("createdBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message:
        "Stock transfer submitted successfully. Waiting for admin approval.",
      data: populatedTransfer,
    });
  } catch (error) {
    console.error("Error submitting stock transfer:", error);
    res.status(400).json({
      success: false,
      message: error.message,
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const approveStockTransferByAdmin = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;

    const stockTransfer = await StockTransfer.findById(id);
    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only approve transfers involving your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const approvedTransfer = await stockTransfer.approveByAdmin(userId);

    const populatedTransfer = await StockTransfer.findById(approvedTransfer._id)
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumbers"
      )
      .populate("createdBy", "_id fullName email")
      .populate("adminApproval.approvedBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message: "Stock transfer approved by admin successfully",
      data: populatedTransfer,
    });
  } catch (error) {
    console.error("Error approving stock transfer by admin:", error);
    res.status(400).json({
      success: false,
      message: error.message,
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const rejectStockTransferByAdmin = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;

    const stockTransfer = await StockTransfer.findById(id);
    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only reject transfers involving your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const rejectedTransfer = await stockTransfer.rejectByAdmin(userId);

    const populatedTransfer = await StockTransfer.findById(rejectedTransfer._id)
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumbers"
      )
      .populate("createdBy", "_id fullName email")
      .populate("adminApproval.rejectedBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message: "Stock transfer rejected by admin",
      data: populatedTransfer,
    });
  } catch (error) {
    console.error("Error rejecting stock transfer by admin:", error);
    res.status(400).json({
      success: false,
      message: error.message,
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const validateSerialNumbers = async (req, res) => {
  try {
    const { id } = req.params;
    const { productApprovals } = req.body;

    const stockTransfer = await StockTransfer.findById(id);
    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    const validationResults = await stockTransfer.validateSerialNumbers(
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

export const getAvailableSerials = async (req, res) => {
  try {
    const { id } = req.params;

    const stockTransfer = await StockTransfer.findById(id);
    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    const availableSerials = await stockTransfer.getAvailableSerials();

    res.status(200).json({
      success: true,
      message: "Available serial numbers retrieved successfully",
      data: availableSerials,
    });
  } catch (error) {
    console.error("Error retrieving available serial numbers:", error);
    res.status(500).json({
      success: false,
      message: "Error retrieving available serial numbers",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const confirmStockTransfer = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
        "approval_transfer_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center, manage_stock_transfer_all_center, or approval_transfer_center permission required.",
      });
    }

    const { id } = req.params;
    const { productApprovals } = req.body;

    const stockTransfer = await StockTransfer.findById(id);
    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only confirm transfers involving your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const Product = mongoose.model("Product");

    if (productApprovals && productApprovals.length > 0) {
      for (const approval of productApprovals) {
        if (!approval.productId) {
          return res.status(400).json({
            success: false,
            message: "Each approval must have a productId",
          });
        }

        if (
          approval.approvedQuantity === undefined ||
          approval.approvedQuantity === null
        ) {
          return res.status(400).json({
            success: false,
            message: "Each approval must have an approvedQuantity",
          });
        }

        if (approval.approvedQuantity < 0) {
          return res.status(400).json({
            success: false,
            message: "Approved quantity cannot be negative",
          });
        }

        if (!Number.isInteger(approval.approvedQuantity)) {
          return res.status(400).json({
            success: false,
            message: "Approved quantity must be an integer",
          });
        }

        const productItem = stockTransfer.products.find(
          (p) => p.product.toString() === approval.productId.toString()
        );

        if (!productItem) {
          return res.status(400).json({
            success: false,
            message: `Product with ID ${approval.productId} not found in this transfer`,
          });
        }

        if (approval.approvedQuantity > productItem.quantity) {
          return res.status(400).json({
            success: false,
            message: `Approved quantity (${approval.approvedQuantity}) cannot exceed requested quantity (${productItem.quantity}) for product`,
          });
        }

        const productDoc = await Product.findById(approval.productId);

        const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";

        if (tracksSerialNumbers) {
          if (approval.approvedQuantity > 0) {
            if (
              !approval.approvedSerials ||
              !Array.isArray(approval.approvedSerials)
            ) {
              return res.status(400).json({
                success: false,
                message: `Serial numbers are required for product ${productDoc.productTitle} as it tracks serial numbers`,
              });
            }

            if (approval.approvedSerials.length !== approval.approvedQuantity) {
              return res.status(400).json({
                success: false,
                message: `Number of serial numbers (${approval.approvedSerials.length}) must match approved quantity (${approval.approvedQuantity}) for product ${productDoc.productTitle}`,
              });
            }

            const uniqueSerials = new Set(approval.approvedSerials);
            if (uniqueSerials.size !== approval.approvedSerials.length) {
              return res.status(400).json({
                success: false,
                message: `Duplicate serial numbers found for product ${productDoc.productTitle}`,
              });
            }

            const emptySerials = approval.approvedSerials.filter(
              (sn) => !sn || sn.trim() === ""
            );
            if (emptySerials.length > 0) {
              return res.status(400).json({
                success: false,
                message: `Serial numbers cannot be empty for product ${productDoc.productTitle}`,
              });
            }
          } else {
            if (
              approval.approvedSerials &&
              approval.approvedSerials.length > 0
            ) {
              return res.status(400).json({
                success: false,
                message: `Serial numbers should not be provided when approved quantity is zero for product ${productDoc.productTitle}`,
              });
            }
          }
        } else {
          if (approval.approvedSerials && approval.approvedSerials.length > 0) {
            return res.status(400).json({
              success: false,
              message: `Serial numbers should not be provided for product ${productDoc.productTitle} as it does not track serial numbers`,
            });
          }
        }

        if (
          approval.approvedQuantity === 0 &&
          (!approval.approvedRemark || approval.approvedRemark.trim() === "")
        ) {
          return res.status(400).json({
            success: false,
            message: `Approval remark is required when approved quantity is zero for product ${productDoc.productTitle}`,
          });
        }
      }

      const validationResults = await stockTransfer.validateSerialNumbers(
        productApprovals.filter((pa) => pa.approvedQuantity > 0)
      );
      const invalidResults = validationResults.filter(
        (result) => !result.valid
      );

      if (invalidResults.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Serial number validation failed",
          validationErrors: invalidResults.map((result) => ({
            productId: result.productId,
            productName: result.productName,
            error: result.error,
          })),
        });
      }
    }

    const confirmedTransfer = await stockTransfer.confirmTransfer(
      userId,
      productApprovals
    );

    // UPDATED: Handle both serialized and non-serialized products
    if (productApprovals && productApprovals.length > 0) {
      const CenterStock = mongoose.model("CenterStock");
      const Product = mongoose.model("Product");

      for (const approval of productApprovals) {
        const approvedQty = approval.approvedQuantity || 0;
        
        if (approvedQty <= 0) {
          continue; // Skip if quantity is zero
        }

        const productDoc = await Product.findById(approval.productId);
        const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";

        const centerStock = await CenterStock.findOne({
          center: stockTransfer.fromCenter,
          product: approval.productId,
        });

        if (!centerStock) {
          throw new Error(
            `No stock found for product ${productDoc?.productTitle || approval.productId} in source center`
          );
        }

        // Check stock availability
        if (centerStock.availableQuantity < approvedQty) {
          throw new Error(
            `Insufficient stock for product ${productDoc?.productTitle || approval.productId}. Available: ${centerStock.availableQuantity}, Approved: ${approvedQty}`
          );
        }

        if (tracksSerialNumbers) {
          // Handle serialized products
          if (!approval.approvedSerials || approval.approvedSerials.length !== approvedQty) {
            throw new Error(
              `Number of serial numbers must match approved quantity for product ${productDoc.productTitle}`
            );
          }

          for (const serialNumber of approval.approvedSerials) {
            const serial = centerStock.serialNumbers.find(
              (sn) => sn.serialNumber === serialNumber
            );

            if (serial && serial.status === "available") {
              serial.status = "in_transit";
              serial.transferHistory.push({
                fromCenter: stockTransfer.fromCenter,
                toCenter: stockTransfer.toCenter,
                transferDate: new Date(),
                transferType: "outbound_transfer",
                status: "in_transit",
              });
            } else {
              throw new Error(
                `Serial number ${serialNumber} not available for product ${productDoc.productTitle}`
              );
            }
          }
        }

        centerStock.availableQuantity -= approvedQty;
        centerStock.inTransitQuantity += approvedQty;

        await centerStock.save();
      }
    }

    const populatedTransfer = await StockTransfer.findById(
      confirmedTransfer._id
    )
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumber"
      )
      .populate("createdBy", "_id fullName email")
      .populate("centerApproval.approvedBy", "_id fullName email");

    let message = "Stock transfer confirmed successfully";
    let hasSerialAssignments = false;
    let hasQuantityAdjustments = false;

    if (productApprovals && productApprovals.length > 0) {
      const quantityAdjustments = productApprovals.filter(
        (pa) => pa.approvedQuantity !== undefined && pa.approvedQuantity > 0
      ).length;
      
      const serialAssignments = productApprovals.filter(
        (pa) => pa.approvedSerials && pa.approvedSerials.length > 0
      ).length;

      if (quantityAdjustments > 0) {
        hasQuantityAdjustments = true;
        message += ` with ${quantityAdjustments} product quantity adjustment(s)`;
      }

      if (serialAssignments > 0) {
        hasSerialAssignments = true;
        message += ` and ${serialAssignments} serial number assignment(s) marked as in transit`;
      }
    }

    const response = {
      success: true,
      message,
      data: populatedTransfer,
    };

    if (hasSerialAssignments || hasQuantityAdjustments) {
      response.stockUpdates = productApprovals
        .filter((pa) => pa.approvedQuantity > 0)
        .map((pa) => {
          const productItem = populatedTransfer.products.find(
            (p) => p.product._id.toString() === pa.productId.toString()
          );
          return {
            productId: pa.productId,
            productName: productItem?.product?.productTitle || "Unknown Product",
            approvedQuantity: pa.approvedQuantity,
            assignedSerials: pa.approvedSerials?.length || 0,
            stockStatus: "in_transit",
            updatedFields: ["availableQuantity", "inTransitQuantity"]
          };
        });
    }

    res.status(200).json(response);
  } catch (error) {
    console.error("Error confirming stock transfer:", error);

    if (
      error.message.includes("Serial number validation failed") ||
      error.message.includes("Number of serial numbers") ||
      error.message.includes("Duplicate serial numbers") ||
      error.message.includes("serial numbers not available") ||
      error.message.includes("Serial numbers are required") ||
      error.message.includes("Serial numbers should not be provided") ||
      error.message.includes("Approved quantity") ||
      error.message.includes("Approval remark is required") ||
      error.message.includes("Insufficient stock") ||
      error.message.includes("No stock found")
    ) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        error: error.message,
      });
    }

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID or transfer ID",
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

    res.status(400).json({
      success: false,
      message: error.message,
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};


export const completeStockTransfer = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;
    const { productReceipts } = req.body;

    const stockTransfer = await StockTransfer.findById(id)
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumber"
      );

    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only complete transfers involving your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    console.log(`[DEBUG] Starting completeStockTransfer for: ${stockTransfer.transferNumber}`);
    console.log(`[DEBUG] Current status: ${stockTransfer.status}`);
    console.log(`[DEBUG] Stock status:`, stockTransfer.stockStatus);

    // Validate received quantities
    if (productReceipts && productReceipts.length > 0) {
      for (const receipt of productReceipts) {
        const productItem = stockTransfer.products.find(
          (p) => p.product._id.toString() === receipt.productId.toString()
        );

        if (!productItem) {
          return res.status(400).json({
            success: false,
            message: `Product ${receipt.productId} not found in transfer`,
          });
        }

        if (receipt.receivedQuantity > productItem.approvedQuantity) {
          return res.status(400).json({
            success: false,
            message: `Received quantity (${receipt.receivedQuantity}) cannot exceed approved quantity (${productItem.approvedQuantity}) for product`,
          });
        }

        // Update product with received quantities
        productItem.receivedQuantity = receipt.receivedQuantity;
        productItem.receivedRemark = receipt.receivedRemark || "";
      }
    } else {
      // If no productReceipts provided, use approved quantities
      stockTransfer.products.forEach((productItem) => {
        productItem.receivedQuantity = productItem.approvedQuantity || 0;
      });
    }

    // CRITICAL FIX: Don't manually update CenterStock here
    // Let the model's completeTransfer method handle all stock updates
    
    console.log(`[DEBUG] Calling completeTransfer on model...`);
    
    // This will handle all stock updates internally
    const completedTransfer = await stockTransfer.completeTransfer(
      userId,
      productReceipts
    );

    const populatedTransfer = await StockTransfer.findById(
      completedTransfer._id
    )
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumber"
      )
      .populate("createdBy", "_id fullName email")
      .populate("receivingInfo.receivedBy", "_id fullName email")
      .populate("completionInfo.completedBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message: "Stock transfer completed successfully",
      data: populatedTransfer,
    });
  } catch (error) {
    console.error("Error completing stock transfer:", error);

    if (error.message.includes("Received quantity cannot exceed")) {
      return res.status(400).json({
        success: false,
        message: "Quantity validation failed",
        error: error.message,
      });
    }

    if (error.message.includes("Insufficient stock")) {
      return res.status(400).json({
        success: false,
        message: "Stock validation failed",
        error: error.message,
      });
    }

    res.status(400).json({
      success: false,
      message: error.message,
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};


export const shipStockTransfer = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;
    const { shippedDate, expectedDeliveryDate, shipmentDetails, carrierInfo } =
      req.body;

    console.log(`[DEBUG] Starting shipStockTransfer for transfer ID: ${id}`);

    const stockTransfer = await StockTransfer.findById(id)
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumber"
      );

    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    console.log(
      `[DEBUG] Found transfer: ${stockTransfer.transferNumber}, Status: ${stockTransfer.status}`
    );

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only ship transfers involving your own center.",
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
      ...(carrierInfo && { carrierInfo }),
    };

    console.log(
      `[DEBUG] Pre-validating stock and serial number availability...`
    );
    const CenterStock = mongoose.model("CenterStock");

    for (const [index, productItem] of stockTransfer.products.entries()) {
      const product = await mongoose
        .model("Product")
        .findById(productItem.product);
      const requiresSerials = product
        ? product.trackSerialNumber === "Yes"
        : false;

      console.log(`\n[DEBUG] Product ${index + 1}: ${product?.productTitle}`);
      console.log(`[DEBUG] - Requires serial numbers: ${requiresSerials}`);
      console.log(
        `[DEBUG] - Approved quantity: ${productItem.approvedQuantity}`
      );
      console.log(
        `[DEBUG] - Approved serials: ${
          productItem.approvedSerials?.length || 0
        }`
      );

      const centerStock = await CenterStock.findOne({
        center: stockTransfer.fromCenter._id,
        product: productItem.product._id,
      });

      if (centerStock) {
        console.log(
          `[DEBUG] - Available quantity: ${centerStock.availableQuantity}`
        );

        if (requiresSerials) {
          if (
            !productItem.approvedSerials ||
            productItem.approvedSerials.length === 0
          ) {
            return res.status(400).json({
              success: false,
              message: `No serial numbers assigned for product "${product?.productTitle}". Please assign serial numbers during confirmation.`,
              details: {
                product: product?.productTitle,
                requiredQuantity:
                  productItem.approvedQuantity || productItem.quantity,
              },
            });
          }

          const availableSerials = centerStock.validateAndGetSerials(
            productItem.approvedSerials,
            stockTransfer.fromCenter._id
          );

          console.log(
            `[DEBUG] - All ${productItem.approvedSerials.length} assigned serial numbers are available`
          );
        }
      }
    }

    console.log(
      `[DEBUG] All pre-validations passed. Attempting to ship transfer...`
    );

    const shippedTransfer = await stockTransfer.shipTransfer(
      userId,
      shippingDetails
    );
    console.log(
      `[DEBUG] Transfer shipped successfully. New status: ${shippedTransfer.status}`
    );

    const populatedTransfer = await StockTransfer.findById(shippedTransfer._id)
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumber"
      )
      .populate("createdBy", "_id fullName email")
      .populate("shippingInfo.shippedBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message:
        "Stock transfer shipped successfully. Stock deducted from source center using assigned serial numbers.",
      data: populatedTransfer,
    });
  } catch (error) {
    console.error(`[DEBUG] ERROR in shipStockTransfer:`, error.message);
    console.error(`[DEBUG] Error stack:`, error.stack);

    if (
      error.message.includes("No serial numbers assigned") ||
      error.message.includes("assigned serial numbers are not available")
    ) {
      return res.status(400).json({
        success: false,
        message: "Serial number validation failed",
        error: error.message,
      });
    }

    res.status(400).json({
      success: false,
      message: error.message,
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const markStockTransferAsIncomplete = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;
    const { incompleteRemark, receivedProducts } = req.body;

    const stockTransfer = await StockTransfer.findById(id);
    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only mark transfers involving your own center as incomplete.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    if (receivedProducts && Array.isArray(receivedProducts)) {
      stockTransfer.products = stockTransfer.products.map((productItem) => {
        const receivedProduct = receivedProducts.find(
          (rp) => rp.productId.toString() === productItem.product.toString()
        );

        if (receivedProduct) {
          return {
            ...productItem.toObject(),
            receivedQuantity: receivedProduct.receivedQuantity || 0,
            receivedRemark: receivedProduct.receivedRemark || "",
            productInStock: receivedProduct.productInStock || 0,
            productRemark: receivedProduct.productRemark || "",
          };
        }
        return productItem;
      });
    }

    const incompleteTransfer = await stockTransfer.markAsIncomplete(
      userId,
      incompleteRemark
    );

    const populatedTransfer = await StockTransfer.findById(
      incompleteTransfer._id
    )
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumbers"
      )
      .populate("createdBy", "_id fullName email")
      .populate("completionInfo.incompleteBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message: "Stock transfer marked as incomplete",
      data: populatedTransfer,
    });
  } catch (error) {
    console.error("Error marking stock transfer as incomplete:", error);
    res.status(400).json({
      success: false,
      message: error.message,
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const completeIncompleteStockTransfer = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;
    const { productApprovals, productReceipts } = req.body;

    const stockTransfer = await StockTransfer.findById(id)
      .populate("products.product", "trackSerialNumber");

    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only complete incomplete transfers involving your own center.",
      });
    }

    if (stockTransfer.status !== "Incompleted") {
      return res.status(400).json({
        success: false,
        message: "Only incomplete stock transfers can be completed",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const CenterStock = mongoose.model("CenterStock");
    const Product = mongoose.model("Product");

    // Get products to complete
    const productsToComplete = productReceipts && productReceipts.length > 0
      ? productReceipts
      : productApprovals;

    if (!productsToComplete || productsToComplete.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Product approvals or receipts are required",
      });
    }

    console.log(`\n========== COMPLETING INCOMPLETE TRANSFER ==========`);
    console.log(`Transfer ID: ${id}`);
    console.log(`Products to complete:`, JSON.stringify(productsToComplete, null, 2));

    // Process each product
    for (const product of productsToComplete) {
      const productId = product.productId;
      const receivedQuantity = product.receivedQuantity || product.approvedQuantity || 0;
      const receivedRemark = product.receivedRemark || product.approvedRemark || "";

      if (receivedQuantity === 0) {
        console.log(`Skipping product ${productId} - received quantity is 0`);
        continue;
      }

      const productItem = stockTransfer.products.find(
        (p) => p.product._id.toString() === productId.toString()
      );

      if (!productItem) {
        return res.status(400).json({
          success: false,
          message: `Product ${productId} not found in stock transfer`,
        });
      }

      const productDoc = await Product.findById(productId);
      const tracksSerialNumbers = productDoc?.trackSerialNumber === "Yes";

      console.log(`\n--- Processing Product: ${productDoc?.productTitle || productId} ---`);
      console.log(`Received Quantity: ${receivedQuantity}`);
      console.log(`Tracks Serial Numbers: ${tracksSerialNumbers}`);

      // Get source and destination stock
      let sourceStock = await CenterStock.findOne({
        center: stockTransfer.fromCenter,
        product: productId,
      });

      let destStock = await CenterStock.findOne({
        center: stockTransfer.toCenter,
        product: productId,
      });

      if (!sourceStock) {
        return res.status(400).json({
          success: false,
          message: `No source stock found for product ${productDoc?.productTitle || productId}`,
        });
      }

      console.log(`Source stock before - Available: ${sourceStock.availableQuantity}, InTransit: ${sourceStock.inTransitQuantity}, Total: ${sourceStock.totalQuantity}`);

      if (tracksSerialNumbers) {
        // Handle serialized products
        const approvedSerials = productItem.approvedSerials || [];
        const serialsToTransfer = approvedSerials.slice(0, receivedQuantity);

        console.log(`Serials to transfer: ${serialsToTransfer.length} - [${serialsToTransfer.join(", ")}]`);

        // Mark serials as transferred in source
        let transferredCount = 0;
        for (const serialNumber of serialsToTransfer) {
          const serial = sourceStock.serialNumbers.find(
            (sn) => sn.serialNumber === serialNumber
          );

          if (serial && serial.status === "in_transit") {
            serial.status = "transferred";
            serial.currentLocation = stockTransfer.toCenter;
            transferredCount++;

            // Update transfer history
            const transferRecord = serial.transferHistory.find(
              (th) => th.toCenter?.toString() === stockTransfer.toCenter.toString()
            );
            if (transferRecord) {
              transferRecord.status = "completed";
              transferRecord.completedAt = new Date();
            }
            console.log(`  ✅ Transferred serial ${serialNumber}`);
          } else if (serial && serial.status === "transferred") {
            transferredCount++;
            console.log(`  ⚠️ Serial ${serialNumber} already transferred`);
          }
        }

        // Update source stock quantities
        sourceStock.inTransitQuantity -= transferredCount;
        // ✅ FIX: Do NOT decrease totalQuantity for transfers
        // sourceStock.totalQuantity should remain the same (total ever received)

        // Add to destination stock
        if (!destStock) {
          destStock = new CenterStock({
            center: stockTransfer.toCenter,
            product: productId,
            totalQuantity: 0,
            availableQuantity: 0,
            inTransitQuantity: 0,
            consumedQuantity: 0,
            serialNumbers: [],
          });
        }

        // Add serials to destination
        for (const serialNumber of serialsToTransfer) {
          const existingSerial = destStock.serialNumbers.find(
            (sn) => sn.serialNumber === serialNumber
          );

          if (!existingSerial) {
            const sourceSerial = sourceStock.serialNumbers.find(
              (sn) => sn.serialNumber === serialNumber
            );

            destStock.serialNumbers.push({
              serialNumber: serialNumber,
              purchaseId: sourceSerial?.purchaseId || new mongoose.Types.ObjectId(),
              originalOutlet: sourceSerial?.originalOutlet || stockTransfer.fromCenter,
              status: "available",
              currentLocation: stockTransfer.toCenter,
              transferHistory: [
                ...(sourceSerial?.transferHistory || []),
                {
                  fromCenter: stockTransfer.fromCenter,
                  toCenter: stockTransfer.toCenter,
                  transferDate: new Date(),
                  transferType: "inbound_transfer",
                  remark: "Completed from incomplete transfer",
                  referenceId: stockTransfer._id,
                  transferredBy: userId,
                },
              ],
            });
          }
        }

        destStock.totalQuantity += transferredCount;
        destStock.availableQuantity += transferredCount;

        console.log(`Source after - InTransit: ${sourceStock.inTransitQuantity}`);
        console.log(`Destination after - Total: ${destStock.totalQuantity}, Available: ${destStock.availableQuantity}`);

      } else {
        // Handle non-serialized products
        console.log(`Processing non-serialized product`);

        // ✅ FIX: Check if we have enough in_transit stock
        let actualToTransfer = receivedQuantity;
        let inTransitToUse = Math.min(actualToTransfer, sourceStock.inTransitQuantity);

        if (inTransitToUse > 0) {
          sourceStock.inTransitQuantity -= inTransitToUse;
          actualToTransfer -= inTransitToUse;
          console.log(`  Used ${inTransitToUse} units from IN_TRANSIT`);
        }

        // If still need more, take from available (but this shouldn't happen for incomplete)
        if (actualToTransfer > 0) {
          let availableToUse = Math.min(actualToTransfer, sourceStock.availableQuantity);
          if (availableToUse > 0) {
            sourceStock.availableQuantity -= availableToUse;
            actualToTransfer -= availableToUse;
            console.log(`  ⚠️ Used ${availableToUse} units from AVAILABLE (unexpected for incomplete)`);
          }
        }

        if (actualToTransfer > 0) {
          console.log(`  ⚠️ Could only transfer ${receivedQuantity - actualToTransfer} of ${receivedQuantity} units`);
        }

        // ✅ FIX: Do NOT decrease totalQuantity for transfers
        // totalQuantity should remain the same

        // Add to destination stock
        if (!destStock) {
          destStock = new CenterStock({
            center: stockTransfer.toCenter,
            product: productId,
            totalQuantity: 0,
            availableQuantity: 0,
            inTransitQuantity: 0,
            consumedQuantity: 0,
            serialNumbers: [],
          });
        }

        destStock.totalQuantity += receivedQuantity;
        destStock.availableQuantity += receivedQuantity;

        console.log(`Source after - Available: ${sourceStock.availableQuantity}, InTransit: ${sourceStock.inTransitQuantity}`);
        console.log(`Destination after - Total: ${destStock.totalQuantity}, Available: ${destStock.availableQuantity}`);
      }

      // Save both stocks
      await sourceStock.save();
      if (destStock) await destStock.save();

      // Update product item in transfer
      productItem.receivedQuantity = receivedQuantity;
      productItem.receivedRemark = receivedRemark;
    }

    // Update transfer status
    stockTransfer.status = "Completed";
    stockTransfer.receivingInfo = {
      receivedAt: new Date(),
      receivedBy: userId,
    };
    stockTransfer.completionInfo = {
      completedOn: new Date(),
      completedBy: userId,
    };
    stockTransfer.updatedBy = userId;

    const completedTransfer = await stockTransfer.save();

    const populatedTransfer = await StockTransfer.findById(completedTransfer._id)
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate("products.product", "_id productTitle productCode trackSerialNumber")
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email")
      .populate("receivingInfo.receivedBy", "_id fullName email")
      .populate("completionInfo.completedBy", "_id fullName email");

    console.log(`\n========== TRANSFER COMPLETED SUCCESSFULLY ==========\n`);

    res.status(200).json({
      success: true,
      message: "Incomplete stock transfer completed successfully",
      data: populatedTransfer,
    });

  } catch (error) {
    console.error("Error completing incomplete stock transfer:", error);
    res.status(500).json({
      success: false,
      message: "Error completing incomplete stock transfer",
      error: error.message,
    });
  }
};

export const rejectStockTransfer = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;

    const user = await User.findById(req.user?.id);
    if (!user) {
      return res.status(400).json({
        success: false,
        message: "User not found",
      });
    }

    let rejectionType;
    if (user.role === "admin") {
      rejectionType = "admin";
    } else if (user.role === "manager" || user.role === "center_manager") {
      rejectionType = "center";
    } else {
      rejectionType = "center";
    }

    const stockTransfer = await StockTransfer.findById(id);
    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only reject transfers involving your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const CenterStock = mongoose.model("CenterStock");

    let totalRestoredSerials = 0;
    let totalRestoredNonSerialized = 0;

    for (const productItem of stockTransfer.products) {
      const product = await mongoose
        .model("Product")
        .findById(productItem.product);
      const requiresSerials = product
        ? product.trackSerialNumber === "Yes"
        : false;
      const approvedQuantity =
        productItem.approvedQuantity || productItem.quantity;

      if (
        requiresSerials &&
        productItem.approvedSerials &&
        productItem.approvedSerials.length > 0
      ) {
        const centerStock = await CenterStock.findOne({
          center: stockTransfer.fromCenter,
          product: productItem.product,
        });

        if (centerStock) {
          let restoredCount = 0;

          for (const serialNumber of productItem.approvedSerials) {
            const serial = centerStock.serialNumbers.find(
              (sn) => sn.serialNumber === serialNumber
            );

            if (serial) {
              if (
                serial.status === "in_transit" ||
                serial.status === "transferred"
              ) {
                serial.status = "available";
                serial.currentLocation = stockTransfer.fromCenter;
                restoredCount++;

                serial.transferHistory.push({
                  fromCenter: stockTransfer.fromCenter,
                  toCenter: stockTransfer.toCenter,
                  transferDate: new Date(),
                  transferType: "transfer_rejected",
                  remark: `Transfer rejected by ${rejectionType}: ${"No reason provided"}`,
                });
              }
            }
          }

          if (restoredCount > 0) {
            centerStock.inTransitQuantity = Math.max(
              0,
              centerStock.inTransitQuantity - restoredCount
            );
            centerStock.availableQuantity += restoredCount;

            // ✅ FIX: DO NOT increment totalQuantity when restoring serials on rejection
            // totalQuantity should remain the same, as it represents total ever received.
            // The serials were already counted in totalQuantity when purchased.
            
            // const transferredSerials = productItem.approvedSerials.filter(
            //   (serialNumber) => {
            //     const serial = centerStock.serialNumbers.find(
            //       (sn) => sn.serialNumber === serialNumber
            //     );
            //     return (
            //       serial &&
            //       serial.status === "available" &&
            //       serial.currentLocation?.toString() ===
            //         stockTransfer.fromCenter.toString()
            //     );
            //   }
            // ).length;

            // if (transferredSerials > 0) {
            //   centerStock.totalQuantity += transferredSerials; // ❌ REMOVED THIS LINE
            // }

            await centerStock.save();
            totalRestoredSerials += restoredCount;

            console.log(
              `[DEBUG] Restored ${restoredCount} serials to available status for product ${productItem.product} (totalQuantity unchanged)`
            );
          }
        }
      } else if (!requiresSerials && approvedQuantity > 0) {
        const centerStock = await CenterStock.findOne({
          center: stockTransfer.fromCenter,
          product: productItem.product,
        });

        if (centerStock) {
          const wasDeducted = centerStock.inTransitQuantity >= approvedQuantity;

          if (wasDeducted) {
            centerStock.availableQuantity += approvedQuantity;
            centerStock.inTransitQuantity -= approvedQuantity;
            totalRestoredNonSerialized += approvedQuantity;
          } else {
            centerStock.availableQuantity += approvedQuantity;
            totalRestoredNonSerialized += approvedQuantity;
          }

          await centerStock.save();
          console.log(
            `[DEBUG] Restored ${approvedQuantity} non-serialized units for product ${productItem.product}`
          );
        }
      }
    }

    if (stockTransfer.stockStatus.sourceDeducted) {
      await stockTransfer.reverseSourceDeduction();
    }

    if (stockTransfer.stockStatus.destinationAdded) {
      await stockTransfer.reverseDestinationAddition();
    }

    let rejectedTransfer;
    if (rejectionType === "admin") {
      rejectedTransfer = await stockTransfer.rejectByAdmin(userId);
    } else {
      rejectedTransfer = await stockTransfer.rejectByCenter(userId);
    }

    const populatedTransfer = await StockTransfer.findById(rejectedTransfer._id)
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumber"
      )
      .populate("createdBy", "_id fullName email")
      .populate("adminApproval.rejectedBy", "_id fullName email")
      .populate("centerApproval.rejectedBy", "_id fullName email")
      .populate("completionInfo.incompleteBy", "_id fullName email");

    let summaryMessage = `Stock transfer rejected by ${rejectionType} successfully. `;

    if (totalRestoredSerials > 0) {
      summaryMessage += `${totalRestoredSerials} serialized items restored to available status. `;
    }

    if (totalRestoredNonSerialized > 0) {
      summaryMessage += `${totalRestoredNonSerialized} non-serialized units regained. `;
    }

    if (totalRestoredSerials === 0 && totalRestoredNonSerialized === 0) {
      summaryMessage += "No stock adjustments were needed.";
    }

    res.status(200).json({
      success: true,
      message: summaryMessage.trim(),
      data: populatedTransfer,
      restorationSummary: {
        serializedItemsRestored: totalRestoredSerials,
        nonSerializedUnitsRegained: totalRestoredNonSerialized,
        totalItemsRestored: totalRestoredSerials + totalRestoredNonSerialized,
        rejectionType: rejectionType,
        rejectedByRole: user.role,
        rejectedByName: user.fullName,
      },
    });
  } catch (error) {
    console.error("Error rejecting stock transfer:", error);
    res.status(400).json({
      success: false,
      message: error.message,
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

const buildStockTransferFilter = (query) => {
  const {
    status,
    fromCenter,
    toCenter,
    startDate,
    endDate,
    createdAtStart,
    createdAtEnd,
    transferNumber,
    search,
    dateFilter,
    customStartDate,
    customEndDate,
    outlet, // Add outlet filter
    center, // Add center filter
    statusChanged, // Add status changed filter
    statusStartDate, // Add status start date
    statusEndDate, // Add status end date
  } = query;

  const filter = {};

  // Status filter
  const statusFilter = buildArrayFilter(status);
  if (statusFilter) filter.status = statusFilter;

  // Status Changed filter
  if (statusChanged && statusChanged !== 'Any Status') {
    filter.status = statusChanged;
  }

  // From Center filter (source center)
  const fromCenterFilter = buildArrayFilter(fromCenter);
  if (fromCenterFilter) {
    if (Array.isArray(fromCenterFilter.$in)) {
      filter.fromCenter = { 
        $in: fromCenterFilter.$in.map(id => 
          mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
        )
      };
    } else if (mongoose.Types.ObjectId.isValid(fromCenterFilter)) {
      filter.fromCenter = new mongoose.Types.ObjectId(fromCenterFilter);
    } else {
      filter.fromCenter = fromCenterFilter;
    }
  }

  // To Center filter (destination center)
  const toCenterFilter = buildArrayFilter(toCenter);
  if (toCenterFilter) {
    if (Array.isArray(toCenterFilter.$in)) {
      filter.toCenter = { 
        $in: toCenterFilter.$in.map(id => 
          mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
        )
      };
    } else if (mongoose.Types.ObjectId.isValid(toCenterFilter)) {
      filter.toCenter = new mongoose.Types.ObjectId(toCenterFilter);
    } else {
      filter.toCenter = toCenterFilter;
    }
  }

  // Outlet filter (filter by fromCenter where centerType is outlet)
  const outletFilter = buildArrayFilter(outlet);
  if (outletFilter) {
    if (Array.isArray(outletFilter.$in)) {
      filter.fromCenter = { 
        $in: outletFilter.$in.map(id => 
          mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
        )
      };
    } else if (mongoose.Types.ObjectId.isValid(outletFilter)) {
      filter.fromCenter = new mongoose.Types.ObjectId(outletFilter);
    } else {
      filter.fromCenter = outletFilter;
    }
  }

  // Center filter (general center filter - applies to both fromCenter and toCenter)
  const centerFilter = buildArrayFilter(center);
  if (centerFilter) {
    if (Array.isArray(centerFilter.$in)) {
      const centerIds = centerFilter.$in.map(id => 
        mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
      );
      filter.$or = [
        { fromCenter: { $in: centerIds } },
        { toCenter: { $in: centerIds } }
      ];
    } else if (mongoose.Types.ObjectId.isValid(centerFilter)) {
      const centerId = new mongoose.Types.ObjectId(centerFilter);
      filter.$or = [
        { fromCenter: centerId },
        { toCenter: centerId }
      ];
    } else {
      filter.$or = [
        { fromCenter: centerFilter },
        { toCenter: centerFilter }
      ];
    }
  }

  // Date filters - Multiple date filter options
  if (statusStartDate && statusEndDate) {
    // Status change date filter
    filter.date = {
      $gte: new Date(statusStartDate),
      $lte: new Date(statusEndDate)
    };
  } else if (startDate && endDate) {
    // Transfer date filter
    filter.date = {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  } else {
    // Original date filter logic
    const dateFilterObj = buildDateFilter(
      dateFilter,
      customStartDate,
      customEndDate,
      startDate,
      endDate
    );
    if (dateFilterObj) filter.date = dateFilterObj;
  }

  // CreatedAt filter
  if (createdAtStart || createdAtEnd) {
    filter.createdAt = {};
    if (createdAtStart) filter.createdAt.$gte = new Date(createdAtStart);
    if (createdAtEnd) filter.createdAt.$lte = new Date(createdAtEnd);
  }

  // Transfer Number filter
  const transferNumberFilter = buildArrayFilter(transferNumber);
  if (transferNumberFilter) {
    filter.transferNumber =
      typeof transferNumberFilter === "object"
        ? transferNumberFilter
        : { $regex: transferNumberFilter, $options: "i" };
  }

  // Search filter
  if (search) {
    filter.$or = [
      { transferNumber: { $regex: search, $options: "i" } },
      { remark: { $regex: search, $options: "i" } },
      { "products.productRemark": { $regex: search, $options: "i" } },
      { "adminApproval.approvalRemark": { $regex: search, $options: "i" } },
      { "adminApproval.rejectionRemark": { $regex: search, $options: "i" } },
      { "centerApproval.approvalRemark": { $regex: search, $options: "i" } },
      { "centerApproval.rejectionRemark": { $regex: search, $options: "i" } },
      { "shippingInfo.shippingRemark": { $regex: search, $options: "i" } },
      { "receivingInfo.receivingRemark": { $regex: search, $options: "i" } },
    ];
  }

  console.log('Stock Transfer Filter:', JSON.stringify(filter, null, 2));
  return filter;
};

const buildStockTransferSortOptions = (
  sortBy = "createdAt",
  sortOrder = "desc"
) => {
  const validSortFields = [
    "createdAt",
    "updatedAt",
    "date",
    "transferNumber",
    "status",
    "adminApproval.approvedAt",
    "adminApproval.rejectedAt",
    "centerApproval.approvedAt",
    "centerApproval.rejectedAt",
    "shippingInfo.shippedAt",
    "receivingInfo.receivedAt",
  ];

  const actualSortBy = validSortFields.includes(sortBy) ? sortBy : "createdAt";
  return { [actualSortBy]: sortOrder === "desc" ? -1 : 1 };
};

const stockTransferPopulateOptions = [
  { path: "fromCenter", select: "_id centerName centerCode centerType" },
  { path: "toCenter", select: "_id centerName centerCode centerType" },
  {
    path: "products.product",
    select: "_id productTitle productCode productImage trackSerialNumbers",
  },
  { path: "createdBy", select: "_id fullName email" },
  { path: "updatedBy", select: "_id fullName email" },
  { path: "adminApproval.approvedBy", select: "_id fullName email" },
  { path: "adminApproval.rejectedBy", select: "_id fullName email" },
  { path: "centerApproval.approvedBy", select: "_id fullName email" },
  { path: "centerApproval.rejectedBy", select: "_id fullName email" },
  { path: "shippingInfo.shippedBy", select: "_id fullName email" },
  { path: "receivingInfo.receivedBy", select: "_id fullName email" },
  { path: "completionInfo.completedBy", select: "_id fullName email" },
  { path: "completionInfo.incompleteBy", select: "_id fullName email" },
];

const centerCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

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

export const getAllStockTransfers = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "stock_transfer_own_center",
        "stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. stock_transfer_own_center or stock_transfer_all_center permission required.",
      });
    }

    const {
      page = 1,
      limit = 100,
      sortBy = "createdAt",
      sortOrder = "desc",
      ...filterParams
    } = req.query;

    console.log('Stock Transfer Filter Params:', filterParams);

    const filter = buildStockTransferFilter(filterParams);
    if (
      permissions.stock_transfer_own_center &&
      !permissions.stock_transfer_all_center &&
      userCenter
    ) {
      const userCenterId = userCenter._id || userCenter;
      if (filter.$or) {
        filter.$or = filter.$or.map(condition => ({
          ...condition,
          $or: [
            { fromCenter: userCenterId },
            { toCenter: userCenterId }
          ]
        }));
      } else {
        filter.$or = [
          { fromCenter: userCenterId },
          { toCenter: userCenterId }
        ];
      }
    }

    const sortOptions = buildStockTransferSortOptions(sortBy, sortOrder);

    const [stockTransfers, total, statusCounts] = await Promise.all([
      StockTransfer.find(filter)
        .populate(stockTransferPopulateOptions)
        .sort(sortOptions)
        .limit(parseInt(limit))
        .skip((parseInt(page) - 1) * parseInt(limit))
        .lean(),

      StockTransfer.countDocuments(filter),

      StockTransfer.aggregate([
        { $match: filter },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    if (stockTransfers.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No stock transfers found",
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

    const statusStats = statusCounts.reduce((acc, stat) => {
      acc[stat._id] = stat.count;
      return acc;
    }, {});

    res.status(200).json({
      success: true,
      message: "Stock transfers retrieved successfully",
      data: stockTransfers,
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
    });
  } catch (error) {
    console.error("Error retrieving stock transfers:", error);
    res.status(500).json({
      success: false,
      message: "Error retrieving stock transfers",
      error: error.message,
    });
  }
};

export const getStockTransferById = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "stock_transfer_own_center",
        "stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. stock_transfer_own_center or stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;

    const stockTransfer = await StockTransfer.findById(id)
      .populate("fromCenter", "_id centerName centerCode centerType email addressLine1 addressLine2 city state")
      .populate("toCenter", "_id centerName centerCode centerType email addressLine1 addressLine2 city state")
      .populate(
        "products.product",
        "_id productTitle salePrice trackSerialNumber"
      )
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email")
      .populate("adminApproval.approvedBy", "_id fullName email")
      .populate("adminApproval.rejectedBy", "_id fullName email")
      .populate("centerApproval.approvedBy", "_id fullName email")
      .populate("shippingInfo.shippedBy", "_id fullName email")
      .populate("receivingInfo.receivedBy", "_id fullName email")
      .populate("completionInfo.completedBy", "_id fullName email")
      .populate("completionInfo.incompleteBy", "_id fullName email")
      .lean();

    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only view transfers involving your own center.",
      });
    }

    res.status(200).json({
      success: true,
      message: "Stock transfer retrieved successfully",
      data: stockTransfer,
    });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid stock transfer ID",
      });
    }

    console.error("Error retrieving stock transfer:", error);
    res.status(500).json({
      success: false,
      message: "Error retrieving stock transfer",
      error: error.message,
    });
  }
};

export const updateStockTransfer = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;
    const { fromCenter, transferNumber, remark, products, date } = req.body;

    const existingTransfer = await StockTransfer.findById(id);
    if (!existingTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!checkTransferCenterAccess(existingTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only update transfers involving your own center.",
      });
    }

    if (existingTransfer.status !== "Draft") {
      return res.status(400).json({
        success: false,
        message: "Only draft transfers can be updated",
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
      ...(fromCenter && { fromCenter }),
      ...(transferNumber && { transferNumber: transferNumber.trim() }),
      ...(remark !== undefined && { remark }),
      ...(date && { date: new Date(date) }),
    };

    if (products) {
      updateData.products = products;
    }

    const updatedTransfer = await StockTransfer.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumbers"
      )
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message: "Stock transfer updated successfully",
      data: updatedTransfer,
    });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid stock transfer ID",
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
          "Transfer number already exists. Please use a different transfer number.",
      });
    }

    console.error("Error updating stock transfer:", error);
    res.status(500).json({
      success: false,
      message: "Error updating stock transfer",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const deleteStockTransfer = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "delete_transfer_own_center",
        "delete_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. delete_transfer_own_center or delete_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;

    const stockTransfer = await StockTransfer.findById(id);

    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only delete transfers involving your own center.",
      });
    }

    if (
      stockTransfer.status == "Completed" ||
      stockTransfer.status == "Shipped" ||
      stockTransfer.status == "Rejected"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Only Completed, Shipped, Rejected transfers can not be deleted",
      });
    }

    await StockTransfer.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: "Stock transfer deleted successfully",
    });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid stock transfer ID",
      });
    }

    console.error("Error deleting stock transfer:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting stock transfer",
      error: error.message,
    });
  }
};

export const getPendingAdminApprovalTransfers = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "indent_all_center",
        "indent_own_center",
      ]);

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
    } = req.query;

    if (
      permissions.indent_own_center &&
      !permissions.indent_all_center &&
      userCenter
    ) {
      const userCenterId = userCenter._id || userCenter;
      filter.$or = [{ fromCenter: userCenterId }, { toCenter: userCenterId }];
    }

    const pendingTransfers = await StockTransfer.findPendingAdminApproval({
      page: parseInt(page),
      limit: parseInt(limit),
      sortBy,
      sortOrder,
    });

    const total = await StockTransfer.countDocuments({
      status: "Submitted",
      "adminApproval.status": { $exists: false },
    });

    res.status(200).json({
      success: true,
      message: "Pending admin approval transfers retrieved successfully",
      data: pendingTransfers,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit),
      },
    });
  } catch (error) {
    console.error("Error retrieving pending admin approval transfers:", error);
    res.status(500).json({
      success: false,
      message: "Error retrieving pending admin approval transfers",
      error: error.message,
    });
  }
};

export const getTransferStats = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "stock_transfer_own_center",
        "stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. stock_transfer_own_center or stock_transfer_all_center permission required.",
      });
    }

    const user = await User.findById(req.user.id).populate("center");
    let centerId = null;

    if (user && user.center) {
      centerId = user.center._id;
    }

    if (
      permissions.stock_transfer_own_center &&
      !permissions.stock_transfer_all_center &&
      userCenter
    ) {
      centerId = userCenter._id || userCenter;
    }

    const stats = await StockTransfer.getTransferStats(centerId);

    res.status(200).json({
      success: true,
      message: "Transfer statistics retrieved successfully",
      data: stats,
    });
  } catch (error) {
    console.error("Error retrieving transfer statistics:", error);
    res.status(500).json({
      success: false,
      message: "Error retrieving transfer statistics",
      error: error.message,
    });
  }
};

export const updateShippingInfo = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;
    const {
      shippedDate,
      expectedDeliveryDate,
      shipmentDetails,
      carrierInfo,
      documents,
    } = req.body;

    const stockTransfer = await StockTransfer.findById(id);
    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!["Shipped", "Confirmed"].includes(stockTransfer.status)) {
      return res.status(400).json({
        success: false,
        message:
          "Shipping info can only be updated for Shipped or Confirmed transfers",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only update shipping info for transfers involving your own center.",
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
    };

    const shippingInfoUpdate = { ...stockTransfer.shippingInfo.toObject() };

    if (shippedDate) shippingInfoUpdate.shippedDate = new Date(shippedDate);
    if (expectedDeliveryDate) {
      shippingInfoUpdate.expectedDeliveryDate = new Date(expectedDeliveryDate);
    }
    if (shipmentDetails) shippingInfoUpdate.shipmentDetails = shipmentDetails;
    if (carrierInfo) shippingInfoUpdate.carrierInfo = carrierInfo;
    if (documents) {
      shippingInfoUpdate.documents = Array.isArray(documents)
        ? documents
        : [documents];
    }

    updateData.shippingInfo = shippingInfoUpdate;

    let updatedTransfer;
    try {
      updatedTransfer = await StockTransfer.findByIdAndUpdate(id, updateData, {
        new: true,
        runValidators: true,
      });
    } catch (validationError) {
      console.warn(
        "Validation error during shipping update, trying alternative approach:",
        validationError.message
      );

      updatedTransfer = await StockTransfer.findByIdAndUpdate(id, updateData, {
        new: true,
        runValidators: false,
      });

      try {
        await updatedTransfer.validate();
      } catch (manualValidationError) {
        return res.status(400).json({
          success: false,
          message: "Validation error in shipping information",
          error: manualValidationError.message,
        });
      }
    }

    const populatedTransfer = await StockTransfer.findById(updatedTransfer._id)
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumbers"
      )
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email")
      .populate("shippingInfo.shippedBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message: "Shipping information updated successfully",
      data: populatedTransfer,
    });
  } catch (error) {
    console.error("Error updating shipping information:", error);

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
      message: "Error updating shipping information",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const rejectShipping = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;

    const stockTransfer = await StockTransfer.findById(id);
    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (stockTransfer.status !== "Shipped") {
      return res.status(400).json({
        success: false,
        message: "Only shipped transfers can have shipping rejected",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only reject shipping for transfers involving your own center.",
      });
    }

    const userId = req.user?.id;
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User authentication required",
      });
    }

    const previousShippingInfo = { ...stockTransfer.shippingInfo.toObject() };

    if (stockTransfer.stockStatus.sourceDeducted) {
      await revertStockDeduction(stockTransfer);
    }

    const updateData = {
      status: "Confirmed",
      updatedBy: userId,
      "shippingInfo.shippedAt": null,
      "shippingInfo.shippedBy": null,
      "shippingInfo.shippedDate": null,
      "shippingInfo.expectedDeliveryDate": null,
      "shippingInfo.shipmentDetails": null,
      "shippingInfo.carrierInfo": null,
      "shippingInfo.documents": [],
      "shippingInfo.shipmentRejected.rejectedAt": new Date(),
      "shippingInfo.shipmentRejected.rejectedBy": userId,
      "shippingInfo.shipmentRejected.rejectionRemark": "",
      "shippingInfo.shipmentRejected.previousShippingData":
        previousShippingInfo,
      "stockStatus.sourceDeducted": false,
      "stockStatus.deductedAt": null,
      "stockStatus.lastStockCheck": new Date(),
    };

    const updatedTransfer = await StockTransfer.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: false }
    );

    const populatedTransfer = await StockTransfer.findById(updatedTransfer._id)
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate(
        "products.product",
        "_id productTitle productCode trackSerialNumbers"
      )
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email")
      .populate("shippingInfo.shippedBy", "_id fullName email");

    res.status(200).json({
      success: true,
      message:
        "Shipping rejected successfully. Transfer reverted to Confirmed status.",
      data: populatedTransfer,
    });
  } catch (error) {
    console.error("Error rejecting shipping:", error);
    res.status(500).json({
      success: false,
      message: "Error rejecting shipping",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

const revertStockDeduction = async (stockTransfer) => {
  try {
    const CenterStock = mongoose.model("CenterStock");

    for (const item of stockTransfer.products) {
      const centerStock = await CenterStock.findOne({
        center: stockTransfer.fromCenter,
        product: item.product,
      });

      if (centerStock) {
        const quantityToRevert = item.approvedQuantity || item.quantity;

        if (
          item.requiresSerialNumbers &&
          item.serialNumbers &&
          item.serialNumbers.length > 0
        ) {
          await centerStock.revertSerialNumbers(item.serialNumbers);
        } else {
          centerStock.availableQuantity += quantityToRevert;
          // centerStock.totalQuantity += quantityToRevert; // ❌ REMOVED - totalQuantity should not change on rejection
          await centerStock.save();
        }
      }
    }
  } catch (error) {
    console.error("Error reverting stock deduction:", error);
    throw new Error(`Failed to revert stock deduction: ${error.message}`);
  }
};


export const getMostRecentTransferNumber = async (req, res) => {
  try {
    const mostRecentTransfer = await StockTransfer.findOne()
      .sort({ createdAt: -1 })
      .select("transferNumber createdAt")
      .lean();

    if (!mostRecentTransfer) {
      return res.status(404).json({
        success: false,
        message: "No stock transfers found",
        data: null,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Most recent transfer number retrieved successfully",
      data: {
        transferNumber: mostRecentTransfer.transferNumber,
        createdAt: mostRecentTransfer.createdAt,
      },
    });
  } catch (error) {
    console.error("Error retrieving most recent transfer number:", error);
    return res.status(500).json({
      success: false,
      message: "Error retrieving most recent transfer number",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

export const updateApprovedQuantities = async (req, res) => {
  try {
    const { hasAccess, permissions, userCenter } =
      checkStockTransferPermissions(req, [
        "manage_stock_transfer_own_center",
        "manage_stock_transfer_all_center",
      ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. manage_stock_transfer_own_center or manage_stock_transfer_all_center permission required.",
      });
    }

    const { id } = req.params;
    const { productApprovals } = req.body;

    console.log(`[DEBUG] === UPDATE APPROVED QUANTITIES START ===`);
    console.log(`[DEBUG] Transfer ID: ${id}`);
    console.log(`[DEBUG] Request Body:`, JSON.stringify(req.body, null, 2));

    const stockTransfer = await StockTransfer.findById(id);
    if (!stockTransfer) {
      return res.status(404).json({
        success: false,
        message: "Stock transfer not found",
      });
    }

    if (!checkTransferCenterAccess(stockTransfer, userCenter, permissions)) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. You can only update approved quantities for transfers involving your own center.",
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
      !productApprovals ||
      !Array.isArray(productApprovals) ||
      productApprovals.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Product approvals array is required and cannot be empty",
      });
    }

    const CenterStock = mongoose.model("CenterStock");
    const Product = mongoose.model("Product");

    console.log(`[DEBUG] === CURRENT TRANSFER STATE ===`);
    console.log(`[DEBUG] Transfer Status: ${stockTransfer.status}`);
    console.log(
      `[DEBUG] Current Products:`,
      stockTransfer.products.map((p) => ({
        product: p.product.toString(),
        quantity: p.quantity,
        approvedQuantity: p.approvedQuantity,
        approvedSerials: p.approvedSerials || [],
        requiresSerialNumbers: p.requiresSerialNumbers,
      }))
    );

    console.log(`[DEBUG] === PROCESSING PRODUCT APPROVALS ===`);

    // Validate product approvals FIRST
    for (const approval of productApprovals) {
      console.log(`[DEBUG] Validating approval:`, approval);

      if (!approval.productId) {
        return res.status(400).json({
          success: false,
          message: "Each approval must have a productId",
        });
      }

      if (
        approval.approvedQuantity === undefined ||
        approval.approvedQuantity === null
      ) {
        return res.status(400).json({
          success: false,
          message: "Each approval must have an approvedQuantity",
        });
      }

      if (approval.approvedQuantity < 0) {
        return res.status(400).json({
          success: false,
          message: "Approved quantity cannot be negative",
        });
      }

      const productItem = stockTransfer.products.find(
        (p) => p.product.toString() === approval.productId.toString()
      );

      if (!productItem) {
        return res.status(400).json({
          success: false,
          message: `Product with ID ${approval.productId} not found in this transfer`,
        });
      }

      if (approval.approvedQuantity > productItem.quantity) {
        return res.status(400).json({
          success: false,
          message: `Approved quantity (${approval.approvedQuantity}) cannot exceed requested quantity (${productItem.quantity}) for product`,
        });
      }

      const product = await Product.findById(approval.productId);
      if (!product) {
        return res.status(400).json({
          success: false,
          message: `Product with ID ${approval.productId} not found`,
        });
      }

      const requiresSerials = product.trackSerialNumber === "Yes";
      console.log(
        `[DEBUG] Product: ${product.productTitle}, Requires Serials: ${requiresSerials}`
      );

      if (requiresSerials) {
        const currentApprovedQuantity = productItem.approvedQuantity || productItem.quantity;
        const currentApprovedSerials = productItem.approvedSerials || [];
        const newApprovedQuantity = approval.approvedQuantity;
        const newApprovedSerials = approval.approvedSerials || [];

        console.log(`[DEBUG] Processing product: ${product.productTitle}`);
        console.log(
          `[DEBUG] Current quantity: ${currentApprovedQuantity}, New quantity: ${newApprovedQuantity}`
        );
        console.log(
          `[DEBUG] Current serials: [${currentApprovedSerials.join(", ")}]`
        );
        console.log(`[DEBUG] New serials: [${newApprovedSerials.join(", ")}]`);

        // Validate serial numbers
        if (newApprovedSerials.length > 0 && newApprovedSerials.length !== newApprovedQuantity) {
          return res.status(400).json({
            success: false,
            message: `Number of serial numbers (${newApprovedSerials.length}) must match approved quantity (${newApprovedQuantity}) for product ${product.productTitle}`,
          });
        }

        if (newApprovedSerials.length > 0) {
          const centerStock = await CenterStock.findOne({
            center: stockTransfer.fromCenter,
            product: approval.productId,
          });

          if (!centerStock) {
            return res.status(400).json({
              success: false,
              message: `No stock found for product ${product.productTitle} in source center`,
            });
          }

          // FIXED: Use direct validation similar to stock request
          const availableSerials = [];
          const unavailableSerials = [];

          for (const serialNumber of newApprovedSerials) {
            const serial = centerStock.serialNumbers.find(
              (sn) => sn.serialNumber === serialNumber
            );

            if (serial) {
              // Check if serial is available at the source center
              if (serial.status === "available") {
                availableSerials.push(serialNumber);
              } else if (serial.status === "in_transit") {
                // Check if it's already assigned to this transfer
                const isAssignedToThisTransfer = currentApprovedSerials.includes(serialNumber);
                if (isAssignedToThisTransfer) {
                  availableSerials.push(serialNumber);
                } else {
                  unavailableSerials.push(serialNumber);
                }
              } else {
                unavailableSerials.push(serialNumber);
              }
            } else {
              unavailableSerials.push(serialNumber);
            }
          }

          if (unavailableSerials.length > 0) {
            return res.status(400).json({
              success: false,
              message: `Some serial numbers are not available for product ${product.productTitle}: ${unavailableSerials.join(", ")}`,
            });
          }
        }
      }
    }

    console.log(`[DEBUG] === UPDATING CENTER STOCKS ===`);

    // Process each approval and update center stocks
    for (const approval of productApprovals) {
      const productItem = stockTransfer.products.find(
        (p) => p.product.toString() === approval.productId.toString()
      );

      const product = await Product.findById(approval.productId);
      const requiresSerials = product?.trackSerialNumber === "Yes";

      const currentApprovedQuantity = productItem.approvedQuantity || 0;
      const newApprovedQuantity = approval.approvedQuantity;
      const currentApprovedSerials = productItem.approvedSerials || [];
      const newApprovedSerials = approval.approvedSerials || [];

      const centerStock = await CenterStock.findOne({
        center: stockTransfer.fromCenter,
        product: approval.productId,
      });

      if (!centerStock) {
        return res.status(400).json({
          success: false,
          message: `No stock found for product ${product?.productTitle || approval.productId} in source center`,
        });
      }

      console.log(`[DEBUG] Processing: ${product?.productTitle || approval.productId}`);
      console.log(`[DEBUG] Current approved: ${currentApprovedQuantity}, New approved: ${newApprovedQuantity}`);
      console.log(`[DEBUG] Available stock: ${centerStock.availableQuantity}, In transit: ${centerStock.inTransitQuantity}`);

      if (requiresSerials) {
        // Handle serialized products
        if (newApprovedQuantity < currentApprovedQuantity) {
          console.log(`[DEBUG] Quantity reduced from ${currentApprovedQuantity} to ${newApprovedQuantity}`);
          
          const quantityToRestore = currentApprovedQuantity - newApprovedQuantity;
          let serialsToRestore = [];

          if (JSON.stringify(currentApprovedSerials) !== JSON.stringify(newApprovedSerials)) {
            serialsToRestore = currentApprovedSerials.filter(
              (serial) => !newApprovedSerials.includes(serial)
            );
          } else {
            serialsToRestore = currentApprovedSerials.slice(newApprovedQuantity);
          }

          console.log(`[DEBUG] Restoring ${serialsToRestore.length} serials`);

          // Restore serials to available status
          for (const serialNumber of serialsToRestore) {
            const serial = centerStock.serialNumbers.find(
              (sn) => sn.serialNumber === serialNumber
            );

            if (serial && serial.status === "in_transit") {
              serial.status = "available";
              serial.currentLocation = stockTransfer.fromCenter;
              
              // Remove transfer history for this specific transfer
              serial.transferHistory = serial.transferHistory.filter(
                (history) =>
                  !(
                    history.toCenter?.toString() === stockTransfer.toCenter.toString() &&
                    history.transferType === "center_to_center"
                  )
              );
            }
          }
          
          centerStock.availableQuantity += quantityToRestore;
          centerStock.inTransitQuantity -= quantityToRestore;
          
        } else if (newApprovedQuantity > currentApprovedQuantity) {
          console.log(`[DEBUG] Quantity increased from ${currentApprovedQuantity} to ${newApprovedQuantity}`);
          
          const quantityToAdd = newApprovedQuantity - currentApprovedQuantity;
          
          if (newApprovedSerials.length < newApprovedQuantity) {
            return res.status(400).json({
              success: false,
              message: `Need ${quantityToAdd} additional serial numbers for quantity increase`,
              productId: approval.productId,
              productName: product?.productTitle || "Unknown Product",
            });
          }

          const additionalSerials = newApprovedSerials.slice(currentApprovedQuantity);
          
          if (additionalSerials.length !== quantityToAdd) {
            return res.status(400).json({
              success: false,
              message: `Need ${quantityToAdd} additional serial numbers but got ${additionalSerials.length}`,
              productId: approval.productId,
            });
          }

          // Mark additional serials as in_transit
          for (const serialNumber of additionalSerials) {
            const serial = centerStock.serialNumbers.find(
              (sn) => sn.serialNumber === serialNumber
            );

            if (serial) {
              if (serial.status === "available") {
                serial.status = "in_transit";
                serial.transferHistory.push({
                  fromCenter: stockTransfer.fromCenter,
                  toCenter: stockTransfer.toCenter,
                  transferDate: new Date(),
                  transferType: "center_to_center",
                  remark: "Added during quantity approval",
                });
              } else if (serial.status === "in_transit") {
                // Add transfer history if not already associated
                const existingTransfer = serial.transferHistory.find(
                  (history) =>
                    history.toCenter?.toString() === stockTransfer.toCenter.toString()
                );

                if (!existingTransfer) {
                  serial.transferHistory.push({
                    fromCenter: stockTransfer.fromCenter,
                    toCenter: stockTransfer.toCenter,
                    transferDate: new Date(),
                    transferType: "center_to_center",
                    remark: "Added during quantity approval",
                  });
                }
              }
            }
          }
          
          centerStock.availableQuantity -= quantityToAdd;
          centerStock.inTransitQuantity += quantityToAdd;
          
        } else if (JSON.stringify(currentApprovedSerials) !== JSON.stringify(newApprovedSerials)) {
          // Same quantity, different serials
          console.log(`[DEBUG] Same quantity (${currentApprovedQuantity}), different serials`);
          
          const serialsToRemove = currentApprovedSerials.filter(
            (serial) => !newApprovedSerials.includes(serial)
          );
          const serialsToAdd = newApprovedSerials.filter(
            (serial) => !currentApprovedSerials.includes(serial)
          );

          console.log(`[DEBUG] Serials to remove: ${serialsToRemove.length}, to add: ${serialsToAdd.length}`);

          // Restore removed serials
          for (const serialNumber of serialsToRemove) {
            const serial = centerStock.serialNumbers.find(
              (sn) => sn.serialNumber === serialNumber
            );

            if (serial && serial.status === "in_transit") {
              serial.status = "available";
              serial.currentLocation = stockTransfer.fromCenter;
              serial.transferHistory = serial.transferHistory.filter(
                (history) =>
                  !(
                    history.toCenter?.toString() === stockTransfer.toCenter.toString() &&
                    history.transferType === "center_to_center"
                  )
              );
            }
          }

          // Mark new serials as in_transit
          for (const serialNumber of serialsToAdd) {
            const serial = centerStock.serialNumbers.find(
              (sn) => sn.serialNumber === serialNumber
            );

            if (serial) {
              if (serial.status === "available") {
                serial.status = "in_transit";
                serial.transferHistory.push({
                  fromCenter: stockTransfer.fromCenter,
                  toCenter: stockTransfer.toCenter,
                  transferDate: new Date(),
                  transferType: "center_to_center",
                  remark: "Swapped during approval",
                });
              } else if (serial.status === "in_transit") {
                const existingTransfer = serial.transferHistory.find(
                  (history) =>
                    history.toCenter?.toString() === stockTransfer.toCenter.toString()
                );

                if (!existingTransfer) {
                  serial.transferHistory.push({
                    fromCenter: stockTransfer.fromCenter,
                    toCenter: stockTransfer.toCenter,
                    transferDate: new Date(),
                    transferType: "center_to_center",
                    remark: "Swapped during approval",
                  });
                }
              }
            }
          }
          
          // Update counts - same quantity, so no net change in quantities
        }
      } else {
        // Handle non-serialized products
        console.log(`[DEBUG] Processing non-serialized product: ${product?.productTitle || approval.productId}`);
        
        if (newApprovedQuantity < currentApprovedQuantity) {
          // Quantity reduced - restore to available
          const quantityToRestore = currentApprovedQuantity - newApprovedQuantity;
          console.log(`[DEBUG] Quantity reduced - restoring ${quantityToRestore} units`);
          
          centerStock.availableQuantity += quantityToRestore;
          centerStock.inTransitQuantity -= quantityToRestore;
          
        } else if (newApprovedQuantity > currentApprovedQuantity) {
          // Quantity increased - check availability and move to in_transit
          const quantityToAdd = newApprovedQuantity - currentApprovedQuantity;
          console.log(`[DEBUG] Quantity increased - adding ${quantityToAdd} units`);
          
          if (centerStock.availableQuantity < quantityToAdd) {
            return res.status(400).json({
              success: false,
              message: `Insufficient stock in center. Required: ${quantityToAdd}, Available: ${centerStock.availableQuantity}`,
              productId: approval.productId,
              productName: product?.productTitle || "Unknown Product",
            });
          }
          
          centerStock.availableQuantity -= quantityToAdd;
          centerStock.inTransitQuantity += quantityToAdd;
        }
        // If quantity unchanged, no stock update needed
      }

      await centerStock.save();
      console.log(`[DEBUG] Saved center stock for ${product?.productTitle || approval.productId}`);
      console.log(`[DEBUG] New available: ${centerStock.availableQuantity}, New in transit: ${centerStock.inTransitQuantity}`);
    }

    console.log(`[DEBUG] === UPDATING TRANSFER DOCUMENT ===`);

    // Update the transfer document
    const updatedProducts = stockTransfer.products.map((productItem) => {
      const approval = productApprovals.find(
        (pa) => pa.productId.toString() === productItem.product.toString()
      );

      if (approval) {
        const updatedProduct = {
          ...productItem.toObject(),
          approvedQuantity: approval.approvedQuantity,
          approvedRemark: approval.approvedRemark || "",
        };

        // For serialized products, update serials if provided
        if (approval.approvedSerials && approval.approvedSerials.length > 0) {
          updatedProduct.approvedSerials = approval.approvedSerials;
          updatedProduct.requiresSerialNumbers = true;
        }

        return updatedProduct;
      }
      
      return productItem;
    });

    const updateData = {
      products: updatedProducts,
      updatedBy: userId,
    };

    // Update status to Confirmed if it's Submitted
    if (stockTransfer.status === "Submitted") {
      updateData.status = "Confirmed";
      updateData.adminApproval = {
        ...stockTransfer.adminApproval,
        approvedBy: userId,
        approvedAt: new Date(),
      };
    }

    const updatedTransfer = await StockTransfer.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate("fromCenter", "_id centerName centerCode")
      .populate("toCenter", "_id centerName centerCode")
      .populate("products.product", "_id productTitle productCode")
      .populate("createdBy", "_id fullName email")
      .populate("updatedBy", "_id fullName email")
      .populate("adminApproval.approvedBy", "_id fullName email");

    console.log(`[DEBUG] === UPDATE COMPLETE ===`);
    console.log(`[DEBUG] Updated transfer:`, updatedTransfer._id);
    
    res.status(200).json({
      success: true,
      message: "Approved quantities and serial numbers updated successfully",
      data: updatedTransfer,
    });
  } catch (error) {
    console.error("Error updating approved quantities:", error);

    if (
      error.message.includes("serial numbers") ||
      error.message.includes("Insufficient stock") ||
      error.message.includes("not available")
    ) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        error: error.message,
      });
    }

    if (error.name === "CastError") {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID or transfer ID",
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
      message: "Error updating approved quantities",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

async function handleApprovalUpdateScenarios(
  fromCenter,
  productId,
  currentSerials,
  newSerials,
  currentQuantity,
  newQuantity,
  toCenter
) {
  const CenterStock = mongoose.model("CenterStock");
  const centerStock = await CenterStock.findOne({
    center: fromCenter,
    product: productId,
  });

  if (!centerStock) {
    throw new Error("Source center stock not found for product");
  }

  console.log(`[DEBUG] Handling approval update scenarios`);
  console.log(
    `[DEBUG] Current quantity: ${currentQuantity}, New quantity: ${newQuantity}`
  );
  console.log(`[DEBUG] Current serials: [${currentSerials.join(", ")}]`);
  console.log(`[DEBUG] New serials: [${newSerials.join(", ")}]`);

  let quantityChange = newQuantity - currentQuantity;
  let serialsChanged =
    JSON.stringify(currentSerials) !== JSON.stringify(newSerials);

  console.log(
    `[DEBUG] Quantity change: ${quantityChange}, Serials changed: ${serialsChanged}`
  );

  if (quantityChange < 0) {
    const quantityToRestore = Math.abs(quantityChange);
    console.log(`[DEBUG] CASE 1: Quantity reduced by ${quantityToRestore}`);

    let serialsToRestore = [];

    if (serialsChanged && newSerials.length > 0) {
      serialsToRestore = currentSerials.filter(
        (serial) => !newSerials.includes(serial)
      );
    } else {
      serialsToRestore = currentSerials.slice(newQuantity);
    }

    console.log(
      `[DEBUG] Restoring ${
        serialsToRestore.length
      } serials: [${serialsToRestore.join(", ")}]`
    );

    await restoreSerialsToAvailable(
      centerStock,
      serialsToRestore,
      fromCenter,
      toCenter
    );

    centerStock.availableQuantity += quantityToRestore;
    centerStock.inTransitQuantity -= quantityToRestore;
  } else if (quantityChange > 0) {
    const quantityToAdd = quantityChange;
    console.log(`[DEBUG] CASE 2: Quantity increased by ${quantityToAdd}`);

    if (newSerials.length === 0) {
      throw new Error(
        `Quantity increased from ${currentQuantity} to ${newQuantity}. Please provide ${quantityToAdd} additional serial numbers.`
      );
    }

    let additionalSerials = [];
    if (serialsChanged) {
      additionalSerials = newSerials.slice(currentQuantity);
    } else {
      throw new Error(
        `Quantity increased but no new serial numbers provided. Please provide ${quantityToAdd} additional serial numbers.`
      );
    }

    if (additionalSerials.length !== quantityToAdd) {
      throw new Error(
        `Need exactly ${quantityToAdd} additional serial numbers, but got ${additionalSerials.length}`
      );
    }

    console.log(
      `[DEBUG] Adding ${
        additionalSerials.length
      } new serials: [${additionalSerials.join(", ")}]`
    );

    await markSerialsAsInTransit(
      centerStock,
      additionalSerials,
      fromCenter,
      toCenter
    );

    centerStock.availableQuantity -= quantityToAdd;
    centerStock.inTransitQuantity += quantityToAdd;
  } else if (quantityChange === 0 && serialsChanged) {
    console.log(`[DEBUG] CASE 3: Quantity unchanged, only serials changed`);

    if (currentSerials.length === 0 && newSerials.length > 0) {
      console.log(`[DEBUG] Adding serials for the first time`);

      await markSerialsAsInTransit(
        centerStock,
        newSerials,
        fromCenter,
        toCenter
      );

      centerStock.availableQuantity -= newSerials.length;
      centerStock.inTransitQuantity += newSerials.length;

      console.log(
        `[DEBUG] First-time serial assignment - Available: -${newSerials.length}, InTransit: +${newSerials.length}`
      );
    } else if (currentSerials.length > 0 && newSerials.length > 0) {
      console.log(`[DEBUG] Replacing existing serials`);

      const serialsToRemove = currentSerials.filter(
        (serial) => !newSerials.includes(serial)
      );
      const serialsToAdd = newSerials.filter(
        (serial) => !currentSerials.includes(serial)
      );

      console.log(
        `[DEBUG] Removing ${serialsToRemove.length} serials, Adding ${serialsToAdd.length} serials`
      );

      if (serialsToRemove.length !== serialsToAdd.length) {
        throw new Error(
          `When replacing serials, number to remove (${serialsToRemove.length}) must match number to add (${serialsToAdd.length})`
        );
      }

      await restoreSerialsToAvailable(
        centerStock,
        serialsToRemove,
        fromCenter,
        toCenter
      );
      await markSerialsAsInTransit(
        centerStock,
        serialsToAdd,
        fromCenter,
        toCenter
      );
    } else if (currentSerials.length > 0 && newSerials.length === 0) {
      console.log(`[DEBUG] Removing all serial assignments`);

      await restoreSerialsToAvailable(
        centerStock,
        currentSerials,
        fromCenter,
        toCenter
      );

      centerStock.availableQuantity += currentSerials.length;
      centerStock.inTransitQuantity -= currentSerials.length;

      console.log(
        `[DEBUG] Removed all serial assignments - Available: +${currentSerials.length}, InTransit: -${currentSerials.length}`
      );
    }
  } else {
    console.log(`[DEBUG] CASE 4: No changes detected`);
  }

  await centerStock.save();
  console.log(`[DEBUG] Center stock saved successfully`);
}

async function restoreSerialsToAvailable(
  centerStock,
  serialsToRestore,
  fromCenter,
  toCenter
) {
  let restoredCount = 0;

  for (const serialNumber of serialsToRestore) {
    const serial = centerStock.serialNumbers.find(
      (sn) => sn.serialNumber === serialNumber
    );

    if (
      serial &&
      (serial.status === "in_transit" || serial.status === "transferred")
    ) {
      serial.status = "available";
      serial.currentLocation = fromCenter;
      restoredCount++;

      serial.transferHistory.push({
        fromCenter: fromCenter,
        toCenter: toCenter,
        transferDate: new Date(),
        transferType: "transfer_updated",
        remark: "Restored to available during quantity update",
      });

      console.log(
        `[DEBUG] Restored serial ${serialNumber} to available status`
      );
    }
  }

  return restoredCount;
}

async function markSerialsAsInTransit(
  centerStock,
  serialsToAdd,
  fromCenter,
  toCenter
) {
  let addedCount = 0;

  for (const serialNumber of serialsToAdd) {
    const serial = centerStock.serialNumbers.find(
      (sn) => sn.serialNumber === serialNumber && sn.status === "available"
    );

    if (serial) {
      serial.status = "in_transit";
      serial.transferHistory.push({
        fromCenter: fromCenter,
        toCenter: toCenter,
        transferDate: new Date(),
        transferType: "outbound_transfer",
        remark: "Added during serial number update",
      });
      addedCount++;

      console.log(`[DEBUG] Marked serial ${serialNumber} as in_transit`);
    } else {
      throw new Error(
        `Serial number ${serialNumber} is not available or not found`
      );
    }
  }

  return addedCount;
}

export const getWarehouseProductSummary = async (req, res) => {
  try {
    const {
      hasAccess,
      permissions,
      userCenter: userCenterFromPermissions,
    } = checkStockTransferPermissions(req, [
      "stock_transfer_own_center",
      "stock_transfer_all_center",
    ]);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message:
          "Access denied. stock_transfer_own_center or stock_transfer_all_center permission required.",
      });
    }

    const {
      warehouseId,
      productId,
      startDate,
      endDate,
      includeDetails = false,
    } = req.query;

    const userCenterId = req.user?.center;
    if (!userCenterId) {
      return res.status(400).json({
        success: false,
        message: "User is not associated with any center",
      });
    }

    if (
      warehouseId &&
      permissions.stock_transfer_own_center &&
      !permissions.stock_transfer_all_center &&
      userCenterFromPermissions
    ) {
      const userCenterIdFromPermissions =
        userCenterFromPermissions._id || userCenterFromPermissions;
      if (warehouseId !== userCenterIdFromPermissions.toString()) {
        return res.status(403).json({
          success: false,
          message:
            "Access denied. You can only view product summaries for your own center.",
        });
      }
    }

    let userCenter = await Center.findById(userCenterId).select(
      "centerType centerName centerCode"
    );
    if (!userCenter) {
      return res.status(404).json({
        success: false,
        message: "User center not found",
      });
    }

    const isOutlet = userCenter.centerType === "Outlet";
    const isCenter = userCenter.centerType === "Center";

    if (!isOutlet && !isCenter) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid user center type. Must be either 'Outlet' or 'Center'",
      });
    }

    let targetWarehouseId = warehouseId;

    if (isCenter) {
      targetWarehouseId = userCenterId;

      const centerWarehouse = await Center.findOne({
        _id: targetWarehouseId,
        centerType: "Center",
      });

      if (!centerWarehouse) {
        return res.status(404).json({
          success: false,
          message: "Center not found or is not a valid center",
        });
      }
    } else if (isOutlet) {
      if (!targetWarehouseId) {
        targetWarehouseId = userCenterId;
      }

      const warehouse = await Center.findOne({
        _id: targetWarehouseId,
        centerType: "Outlet",
      });

      if (!warehouse) {
        return res.status(404).json({
          success: false,
          message: "Warehouse not found or is not an outlet",
        });
      }
    }

    const targetWarehouse = await Center.findById(targetWarehouseId).select(
      "centerName centerCode centerType"
    );

    if (!targetWarehouse) {
      return res.status(404).json({
        success: false,
        message: "Target warehouse/center not found",
      });
    }

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    let currentStock = [];
    if (isOutlet) {
      currentStock = await OutletStock.find({
        outlet: targetWarehouseId,
      })
        .populate("product", "productTitle productCode trackSerialNumber")
        .lean();
    } else if (isCenter) {
      currentStock = await CenterStock.find({
        center: targetWarehouseId,
      })
        .populate("product", "productTitle productCode trackSerialNumber")
        .lean();
    }

    const centerStockFromWarehouse = await CenterStock.aggregate([
      {
        $match: productId
          ? {
              product: new mongoose.Types.ObjectId(productId),
            }
          : {},
      },
      { $unwind: "$serialNumbers" },
      {
        $match: {
          "serialNumbers.originalOutlet": new mongoose.Types.ObjectId(
            targetWarehouseId
          ),

          ...(isCenter && {
            center: new mongoose.Types.ObjectId(targetWarehouseId),
          }),
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "product",
          foreignField: "_id",
          as: "productDetails",
        },
      },
      {
        $lookup: {
          from: "centers",
          localField: "center",
          foreignField: "_id",
          as: "centerDetails",
        },
      },
      {
        $group: {
          _id: "$product",
          productName: {
            $first: { $arrayElemAt: ["$productDetails.productTitle", 0] },
          },
          productCode: {
            $first: { $arrayElemAt: ["$productDetails.productCode", 0] },
          },
          totalInCenters: { $sum: 1 },
          availableInCenters: {
            $sum: {
              $cond: [{ $eq: ["$serialNumbers.status", "available"] }, 1, 0],
            },
          },
          damagedInCenters: {
            $sum: {
              $cond: [{ $eq: ["$serialNumbers.status", "damaged"] }, 1, 0],
            },
          },
          consumedInCenters: {
            $sum: {
              $cond: [{ $eq: ["$serialNumbers.status", "consumed"] }, 1, 0],
            },
          },
          inTransitInCenters: {
            $sum: {
              $cond: [{ $eq: ["$serialNumbers.status", "in_transit"] }, 1, 0],
            },
          },
          centerDetails: {
            $push: {
              centerId: "$center",
              centerName: { $arrayElemAt: ["$centerDetails.centerName", 0] },
              centerCode: { $arrayElemAt: ["$centerDetails.centerCode", 0] },
              status: "$serialNumbers.status",
              serialNumber: "$serialNumbers.serialNumber",
            },
          },
        },
      },
    ]);

    const purchaseSummary = isOutlet
      ? await StockPurchase.aggregate([
          {
            $match: {
              outlet: new mongoose.Types.ObjectId(targetWarehouseId),
              ...(Object.keys(dateFilter).length > 0 && { date: dateFilter }),
            },
          },
          { $unwind: "$products" },
          {
            $match: productId
              ? {
                  "products.product": new mongoose.Types.ObjectId(productId),
                }
              : {},
          },
          {
            $lookup: {
              from: "products",
              localField: "products.product",
              foreignField: "_id",
              as: "productDetails",
            },
          },
          {
            $group: {
              _id: "$products.product",
              productName: {
                $first: { $arrayElemAt: ["$productDetails.productTitle", 0] },
              },
              productCode: {
                $first: { $arrayElemAt: ["$productDetails.productCode", 0] },
              },
              totalPurchased: { $sum: "$products.purchasedQuantity" },
              currentAvailableInWarehouse: {
                $sum: "$products.availableQuantity",
              },
              purchaseDetails: {
                $push: {
                  invoiceNo: "$invoiceNo",
                  date: "$date",
                  purchasedQty: "$products.purchasedQuantity",
                  availableQty: "$products.availableQuantity",
                  price: "$products.price",
                  status: "$status",
                },
              },
            },
          },
        ])
      : [];

    const stockRequestSummary = await StockRequest.aggregate([
      {
        $match: {
          ...(isOutlet
            ? { warehouse: new mongoose.Types.ObjectId(targetWarehouseId) }
            : { center: new mongoose.Types.ObjectId(targetWarehouseId) }),
          status: "Completed",
          ...(Object.keys(dateFilter).length > 0 && { date: dateFilter }),
        },
      },
      { $unwind: "$products" },
      {
        $match: productId
          ? {
              "products.product": new mongoose.Types.ObjectId(productId),
            }
          : {},
      },
      {
        $lookup: {
          from: "products",
          localField: "products.product",
          foreignField: "_id",
          as: "productDetails",
        },
      },
      {
        $lookup: {
          from: "centers",
          localField: isOutlet ? "center" : "warehouse",
          foreignField: "_id",
          as: isOutlet ? "centerDetails" : "warehouseDetails",
        },
      },
      {
        $group: {
          _id: "$products.product",
          totalTransferredOut: { $sum: "$products.receivedQuantity" },
          transferDetails: {
            $push: {
              orderNumber: "$orderNumber",
              date: "$date",
              [isOutlet ? "toCenter" : "fromWarehouse"]: {
                $arrayElemAt: [
                  isOutlet
                    ? "$centerDetails.centerName"
                    : "$warehouseDetails.centerName",
                  0,
                ],
              },
              [isOutlet ? "toCenterCode" : "fromWarehouseCode"]: {
                $arrayElemAt: [
                  isOutlet
                    ? "$centerDetails.centerCode"
                    : "$warehouseDetails.centerCode",
                  0,
                ],
              },
              transferredQty: "$products.receivedQuantity",
              serialNumbers: "$products.transferredSerials",
            },
          },
        },
      },
    ]);

    const centerUsageSummary = await StockUsage.aggregate([
      {
        $match: {
          status: "completed",
          ...(isCenter && {
            center: new mongoose.Types.ObjectId(targetWarehouseId),
          }),
          ...(Object.keys(dateFilter).length > 0 && { date: dateFilter }),
        },
      },
      { $unwind: "$items" },
      {
        $match: productId
          ? {
              "items.product": new mongoose.Types.ObjectId(productId),
            }
          : {},
      },
      {
        $lookup: {
          from: "products",
          localField: "items.product",
          foreignField: "_id",
          as: "productDetails",
        },
      },
      {
        $lookup: {
          from: "centers",
          localField: "center",
          foreignField: "_id",
          as: "centerDetails",
        },
      },
      {
        $lookup: {
          from: "centers",
          localField: "items.serialNumbers.originalOutlet",
          foreignField: "_id",
          as: "originalOutletDetails",
        },
      },
      {
        $match: isOutlet
          ? {
              "originalOutletDetails._id": new mongoose.Types.ObjectId(
                targetWarehouseId
              ),
            }
          : {
              "centerDetails._id": new mongoose.Types.ObjectId(
                targetWarehouseId
              ),
            },
      },
      {
        $group: {
          _id: "$items.product",
          productName: {
            $first: { $arrayElemAt: ["$productDetails.productTitle", 0] },
          },
          productCode: {
            $first: { $arrayElemAt: ["$productDetails.productCode", 0] },
          },
          totalUsedInCenters: { $sum: "$items.quantity" },
          damageQuantityInCenters: {
            $sum: {
              $cond: [{ $eq: ["$usageType", "Damage"] }, "$items.quantity", 0],
            },
          },
          customerUsageInCenters: {
            $sum: {
              $cond: [
                { $eq: ["$usageType", "Customer"] },
                "$items.quantity",
                0,
              ],
            },
          },
          otherUsageInCenters: {
            $sum: {
              $cond: [
                {
                  $not: {
                    $in: ["$usageType", ["Damage", "Customer"]],
                  },
                },
                "$items.quantity",
                0,
              ],
            },
          },
          usageDetails: {
            $push: {
              date: "$date",
              usageType: "$usageType",
              center: { $arrayElemAt: ["$centerDetails.centerName", 0] },
              centerCode: { $arrayElemAt: ["$centerDetails.centerCode", 0] },
              quantity: "$items.quantity",
              serialNumbers: "$items.serialNumbers",
              remark: "$remark",
            },
          },
        },
      },
    ]);

    const allProductIds = new Set([
      ...currentStock.map((p) => p?.product?._id?.toString()).filter(Boolean),
      ...centerStockFromWarehouse
        .map((p) => p?._id?.toString())
        .filter(Boolean),
      ...purchaseSummary.map((p) => p?._id?.toString()).filter(Boolean),
      ...stockRequestSummary.map((s) => s?._id?.toString()).filter(Boolean),
      ...centerUsageSummary.map((u) => u?._id?.toString()).filter(Boolean),
    ]);

    const productSummary = [];

    for (const productId of allProductIds) {
      if (!productId) continue;

      const currentStockItem = currentStock.find(
        (p) => p?.product?._id?.toString() === productId
      );

      const centerStock = centerStockFromWarehouse.find(
        (c) => c?._id?.toString() === productId
      );

      const purchaseData =
        purchaseSummary.find((p) => p?._id?.toString() === productId) || {};

      const requestData =
        stockRequestSummary.find((s) => s?._id?.toString() === productId) || {};

      const usageData =
        centerUsageSummary.find((u) => u?._id?.toString() === productId) || {};

      const currentWarehouseStock = currentStockItem
        ? {
            total: currentStockItem.totalQuantity || 0,
            available: currentStockItem.availableQuantity || 0,
            inTransit: currentStockItem.inTransitQuantity || 0,
            ...(isCenter && {
              consumed: currentStockItem.consumedQuantity || 0,
            }),
          }
        : {
            total: 0,
            available: 0,
            inTransit: 0,
            ...(isCenter && { consumed: 0 }),
          };

      const centerStockSummary = centerStock
        ? {
            total: centerStock.totalInCenters || 0,
            available: centerStock.availableInCenters || 0,
            damaged: centerStock.damagedInCenters || 0,
            consumed: centerStock.consumedInCenters || 0,
            inTransit: centerStock.inTransitInCenters || 0,
          }
        : {
            total: 0,
            available: 0,
            damaged: 0,
            consumed: 0,
            inTransit: 0,
          };

      const totalPurchased = purchaseData.totalPurchased || 0;
      const totalTransferredOut = requestData.totalTransferredOut || 0;
      const totalUsageInCenters = usageData.totalUsedInCenters || 0;
      const damageInCenters = usageData.damageQuantityInCenters || 0;

      const totalAccountedFor =
        currentWarehouseStock.total + centerStockSummary.total;
      const purchaseAccuracy =
        totalPurchased > 0 ? (totalAccountedFor / totalPurchased) * 100 : 100;

      const productName =
        purchaseData.productName ||
        centerStock?.productName ||
        currentStockItem?.product?.productTitle ||
        usageData.productName ||
        "Unknown Product";

      const productCode =
        purchaseData.productCode ||
        centerStock?.productCode ||
        currentStockItem?.product?.productCode ||
        usageData.productCode ||
        "N/A";

      productSummary.push({
        productId: new mongoose.Types.ObjectId(productId),
        productName,
        productCode,

        currentStock: {
          [isOutlet ? "warehouse" : "center"]: currentWarehouseStock,
          distributedCenters: centerStockSummary,
        },

        historical: {
          totalPurchased,
          totalTransferredToCenters: totalTransferredOut,
          totalUsageInCenters,
          damageInCenters,
        },

        summary: {
          totalStockInSystem:
            currentWarehouseStock.total + centerStockSummary.total,
          totalAvailable:
            currentWarehouseStock.available + centerStockSummary.available,
          totalDamaged: centerStockSummary.damaged + damageInCenters,
          totalConsumed:
            centerStockSummary.consumed + (currentWarehouseStock.consumed || 0),
          stockAccuracy: purchaseAccuracy,
        },

        details: includeDetails
          ? {
              currentStock: currentStockItem
                ? {
                    total: currentStockItem.totalQuantity || 0,
                    available: currentStockItem.availableQuantity || 0,
                    inTransit: currentStockItem.inTransitQuantity || 0,
                    ...(isCenter && {
                      consumed: currentStockItem.consumedQuantity || 0,
                    }),
                    serialNumbers: currentStockItem.serialNumbers?.length || 0,
                  }
                : null,
              centerDistribution: centerStock?.centerDetails || [],
              purchases: purchaseData.purchaseDetails || [],
              transfers: requestData.transferDetails || [],
              usage: usageData.usageDetails || [],
            }
          : undefined,
      });
    }

    if (productId) {
      const product = await Product.findById(productId);
      if (
        product &&
        !productSummary.find((p) => p.productId.toString() === productId)
      ) {
        productSummary.push({
          productId: product._id,
          productName: product.productTitle,
          productCode: product.productCode,
          currentStock: {
            [isOutlet ? "warehouse" : "center"]: {
              total: 0,
              available: 0,
              inTransit: 0,
              ...(isCenter && { consumed: 0 }),
            },
            distributedCenters: {
              total: 0,
              available: 0,
              damaged: 0,
              consumed: 0,
              inTransit: 0,
            },
          },
          historical: {
            totalPurchased: 0,
            totalTransferredToCenters: 0,
            totalUsageInCenters: 0,
            damageInCenters: 0,
          },
          summary: {
            totalStockInSystem: 0,
            totalAvailable: 0,
            totalDamaged: 0,
            totalConsumed: 0,
            stockAccuracy: 0,
          },
          details: includeDetails
            ? {
                currentStock: null,
                centerDistribution: [],
                purchases: [],
                transfers: [],
                usage: [],
              }
            : undefined,
        });
      }
    }

    const summaryTotals = {
      totalProducts: productSummary.length,
      totalStockInSystem: productSummary.reduce(
        (sum, p) => sum + (p.summary.totalStockInSystem || 0),
        0
      ),
      totalAvailable: productSummary.reduce(
        (sum, p) => sum + (p.summary.totalAvailable || 0),
        0
      ),
      totalDamaged: productSummary.reduce(
        (sum, p) => sum + (p.summary.totalDamaged || 0),
        0
      ),
      totalConsumed: productSummary.reduce(
        (sum, p) => sum + (p.summary.totalConsumed || 0),
        0
      ),
      totalPurchased: productSummary.reduce(
        (sum, p) => sum + (p.historical.totalPurchased || 0),
        0
      ),
      totalTransferred: productSummary.reduce(
        (sum, p) => sum + (p.historical.totalTransferredToCenters || 0),
        0
      ),
      averageAccuracy:
        productSummary.length > 0
          ? productSummary.reduce(
              (sum, p) => sum + (p.summary.stockAccuracy || 0),
              0
            ) / productSummary.length
          : 0,
    };

    res.json({
      success: true,
      message: `Product summary retrieved successfully for ${
        isOutlet ? "warehouse" : "center"
      }`,
      data: {
        [isOutlet ? "warehouse" : "center"]: {
          _id: targetWarehouse._id,
          name: targetWarehouse.centerName,
          code: targetWarehouse.centerCode,
          type: targetWarehouse.centerType,
        },
        userCenter: {
          _id: userCenter._id,
          name: userCenter.centerName,
          code: userCenter.centerCode,
          type: userCenter.centerType,
        },
        summary: productSummary,
        summaryTotals,
        stockStatus: {
          inCurrentLocation: summaryTotals.totalAvailable,
          inOtherCenters:
            summaryTotals.totalStockInSystem - summaryTotals.totalAvailable,
          damaged: summaryTotals.totalDamaged,
          consumed: summaryTotals.totalConsumed,
        },
        period: {
          startDate: startDate || "All time",
          endDate: endDate || "All time",
        },
        generatedAt: new Date().toISOString(),
        dataSources: [
          isOutlet
            ? "OutletStock (Current Warehouse Stock)"
            : "CenterStock (Current Center Stock)",
          "CenterStock (Distributed Center Stock)",
          isOutlet
            ? "StockPurchase (Purchase History)"
            : "StockPurchase (Not applicable for centers)",
          "StockRequest (Transfer History)",
          "StockUsage (Usage History)",
        ],
      },
    });
  } catch (error) {
    console.error("Get warehouse product summary error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error retrieving warehouse product summary",
    });
  }
};

/**
 * Get product stock status across all centers from this warehouse
 */
export const getProductDistribution = async (req, res) => {
  try {
    const { warehouseId, productId } = req.query;

    if (!warehouseId || !productId) {
      return res.status(400).json({
        success: false,
        message: "Warehouse ID and Product ID are required",
      });
    }

    const distribution = await CenterStock.aggregate([
      {
        $match: {
          product: new mongoose.Types.ObjectId(productId),
        },
      },
      { $unwind: "$serialNumbers" },
      {
        $match: {
          "serialNumbers.originalOutlet": new mongoose.Types.ObjectId(
            warehouseId
          ),
        },
      },
      {
        $lookup: {
          from: "centers",
          localField: "center",
          foreignField: "_id",
          as: "centerDetails",
        },
      },
      {
        $lookup: {
          from: "products",
          localField: "product",
          foreignField: "_id",
          as: "productDetails",
        },
      },
      {
        $group: {
          _id: "$center",
          centerName: {
            $first: { $arrayElemAt: ["$centerDetails.centerName", 0] },
          },
          centerCode: {
            $first: { $arrayElemAt: ["$centerDetails.centerCode", 0] },
          },
          productName: {
            $first: { $arrayElemAt: ["$productDetails.productTitle", 0] },
          },
          totalQuantity: { $sum: 1 },
          available: {
            $sum: {
              $cond: [{ $eq: ["$serialNumbers.status", "available"] }, 1, 0],
            },
          },
          damaged: {
            $sum: {
              $cond: [{ $eq: ["$serialNumbers.status", "damaged"] }, 1, 0],
            },
          },
          consumed: {
            $sum: {
              $cond: [{ $eq: ["$serialNumbers.status", "consumed"] }, 1, 0],
            },
          },
          inTransit: {
            $sum: {
              $cond: [{ $eq: ["$serialNumbers.status", "in_transit"] }, 1, 0],
            },
          },
          serialNumbers: {
            $push: {
              serialNumber: "$serialNumbers.serialNumber",
              status: "$serialNumbers.status",
              currentLocation: "$center",
              transferHistory: "$serialNumbers.transferHistory",
            },
          },
        },
      },
      {
        $project: {
          centerId: "$_id",
          centerName: 1,
          centerCode: 1,
          productName: 1,
          quantities: {
            total: "$totalQuantity",
            available: "$available",
            damaged: "$damaged",
            consumed: "$consumed",
            inTransit: "$inTransit",
          },
          utilization: {
            availablePercentage: {
              $multiply: [{ $divide: ["$available", "$totalQuantity"] }, 100],
            },
            damagePercentage: {
              $multiply: [{ $divide: ["$damaged", "$totalQuantity"] }, 100],
            },
          },
          serialNumbers: 1,
        },
      },
      { $sort: { "quantities.total": -1 } },
    ]);

    res.json({
      success: true,
      message: "Product distribution across centers retrieved successfully",
      data: {
        warehouseId,
        productId,
        distribution,
        summary: {
          totalCenters: distribution.length,
          totalUnits: distribution.reduce(
            (sum, d) => sum + d.quantities.total,
            0
          ),
          totalAvailable: distribution.reduce(
            (sum, d) => sum + d.quantities.available,
            0
          ),
          totalDamaged: distribution.reduce(
            (sum, d) => sum + d.quantities.damaged,
            0
          ),
        },
      },
    });
  } catch (error) {
    console.error("Get product distribution error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error retrieving product distribution",
    });
  }
};
