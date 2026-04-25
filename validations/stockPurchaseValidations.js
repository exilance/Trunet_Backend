import { body, param, query, validationResult } from "express-validator";
import StockPurchase from "../models/StockPurchase.js";
import OutletStock from "../models/OutletStock.js";
import CenterStock from "../models/CenterStock.js";
import Product from "../models/Product.js";
import Vendor from "../models/Vendor.js";
import Center from "../models/Center.js";
import mongoose from "mongoose";

const customValidators = {
  isObjectId: (value) => {
    if (!value) return false;
    return mongoose.Types.ObjectId.isValid(value);
  },

  isValidOutlet: async (outletId) => {
    if (!outletId) return false;
    const outlet = await Center.findById(outletId);
    return outlet && outlet.centerType === "Outlet";
  },

  productExists: async (productId) => {
    if (!productId) return false;
    const product = await Product.findById(productId);
    return !!product;
  },

  isValidOutletSerial: async (serialNumber, { req }) => {
    if (!serialNumber) return false;
    const { outletId, productId } = req.params;
    const outletStock = await OutletStock.findOne({
      outlet: outletId,
      product: productId,
      "serialNumbers.serialNumber": serialNumber,
      "serialNumbers.status": "available",
    });
    return !!outletStock;
  },

  isValidCenterSerial: async (serialNumber, { req }) => {
    if (!serialNumber) return false;
    const { centerId, productId } = req.params;
    const centerStock = await CenterStock.findOne({
      center: centerId,
      product: productId,
      "serialNumbers.serialNumber": serialNumber,
      "serialNumbers.status": "available",
    });
    return !!centerStock;
  },

  isUniqueSerial: async (newSerialNumber, { req }) => {
    if (!newSerialNumber) return false;
    const outletExists  = await OutletStock.findOne({ "serialNumbers.serialNumber": newSerialNumber });
    const centerExists  = await CenterStock.findOne({ "serialNumbers.serialNumber": newSerialNumber });
    const purchaseExists = await StockPurchase.findOne({ "products.serialNumbers.serialNumber": newSerialNumber });
    return !outletExists && !centerExists && !purchaseExists;
  },

  isValidSerialNumbers: async (serialNumbers, { req }) => {
    if (!serialNumbers || !Array.isArray(serialNumbers)) {
      throw new Error("Serial numbers must be an array");
    }
    if (serialNumbers.length === 0) {
      throw new Error("At least one serial number is required");
    }
    const serialSet = new Set(serialNumbers);
    if (serialSet.size !== serialNumbers.length) {
      throw new Error("Duplicate serial numbers in request");
    }
    return true;
  },

  vendorExists: async (vendorId) => {
    if (!vendorId) return false;
    const vendor = await Vendor.findById(vendorId);
    return !!vendor;
  },

  isValidCenter: async (centerId) => {
    if (!centerId) return false;
    const center = await Center.findById(centerId);
    return center && center.centerType !== "Outlet";
  },

  isUniqueInvoice: async (invoiceNo, { req }) => {
    if (!invoiceNo) return false;
    const filter = {
      invoiceNo: { $regex: new RegExp(`^${invoiceNo}$`, "i") },
    };
    if (req.params.id) {
      filter._id = { $ne: req.params.id };
    }
    const existing = await StockPurchase.findOne(filter);
    return !existing;
  },

  isValidProducts: (products) => {
    if (!products || !Array.isArray(products) || products.length === 0) {
      return false;
    }
    return products.every(
      (product) =>
        product.product && product.price >= 0 && product.purchasedQuantity >= 1
    );
  },

  // ================================================================
  // validateSerialNumbers
  // ================================================================
  // Rules:
  //   CREATE:
  //     - trackSerialNumber=Yes  → serialNumbers required, count must match purchasedQuantity
  //     - trackSerialNumber=No   → serialNumbers must NOT be provided
  //
  //   UPDATE (req.params.id exists):
  //     - trackSerialNumber=Yes + serialNumbers provided
  //         → count must match purchasedQuantity
  //         → no duplicates in request
  //         → no conflicts in OTHER purchases (exclude current)
  //     - trackSerialNumber=Yes + NO serialNumbers provided
  //         → ✅ ALLOWED — controller will use existing serials from DB
  //         → quantity can freely change — controller handles this
  //     - trackSerialNumber=No   → serialNumbers must NOT be provided
  // ================================================================
  validateSerialNumbers: async (products, { req }) => {
    if (!products || !Array.isArray(products)) return true;

    const isUpdate = !!(req.params && req.params.id);
    console.log(`\n[Validator] validateSerialNumbers called`);
    console.log(`[Validator] isUpdate: ${isUpdate}`);
    console.log(`[Validator] purchaseId: ${req.params?.id || "N/A"}`);

    for (const product of products) {
      if (!product.product) continue;

      const productDoc = await Product.findById(product.product);
      if (!productDoc) {
        console.log(`[Validator] Product not found: ${product.product}`);
        continue;
      }

      const tracksSerials = productDoc.trackSerialNumber === "Yes";
      const hasSerials    = product.serialNumbers && Array.isArray(product.serialNumbers) && product.serialNumbers.length > 0;

      console.log(`\n[Validator] ── Product: ${productDoc.productTitle} ──`);
      console.log(`[Validator]   trackSerialNumber : ${productDoc.trackSerialNumber}`);
      console.log(`[Validator]   purchasedQuantity : ${product.purchasedQuantity}`);
      console.log(`[Validator]   serialNumbers sent: ${product.serialNumbers?.length ?? 0}`);

      if (tracksSerials) {
        if (hasSerials) {
          // ── Serials PROVIDED → validate them fully ──

          // 1. Count must match purchasedQuantity
          if (product.serialNumbers.length !== product.purchasedQuantity) {
            const msg = `Product "${productDoc.productTitle}" — serial count (${product.serialNumbers.length}) must match purchasedQuantity (${product.purchasedQuantity})`;
            console.log(`[Validator]   ❌ ${msg}`);
            throw new Error(msg);
          }
          console.log(`[Validator]   ✅ Serial count matches purchasedQuantity`);

          // 2. No duplicates within request
          const serialStrings = product.serialNumbers.map((s) =>
            typeof s === "string" ? s : s.serialNumber
          );
          const serialSet = new Set(serialStrings);
          if (serialSet.size !== serialStrings.length) {
            const msg = `Product "${productDoc.productTitle}" — duplicate serial numbers found in request`;
            console.log(`[Validator]   ❌ ${msg}`);
            throw new Error(msg);
          }
          console.log(`[Validator]   ✅ No duplicate serials in request`);

          // 3. No conflicts in OTHER purchases
          const conflictQuery = {
            "products.serialNumbers.serialNumber": { $in: serialStrings },
          };
          if (isUpdate) {
            conflictQuery._id = { $ne: req.params.id }; // exclude THIS purchase
          }

          const conflictPurchases = await StockPurchase.find(conflictQuery);
          if (conflictPurchases.length > 0) {
            const conflictSerials = [];
            conflictPurchases.forEach((purchase) => {
              purchase.products.forEach((prod) => {
                prod.serialNumbers.forEach((sn) => {
                  if (serialStrings.includes(sn.serialNumber)) {
                    conflictSerials.push(`${sn.serialNumber} (invoice: ${purchase.invoiceNo})`);
                  }
                });
              });
            });

            if (conflictSerials.length > 0) {
              const msg = `Product "${productDoc.productTitle}" — serial numbers already exist in other purchases: ${[...new Set(conflictSerials)].join(", ")}`;
              console.log(`[Validator]   ❌ ${msg}`);
              throw new Error(msg);
            }
          }
          console.log(`[Validator]   ✅ No serial conflicts with other purchases`);

        } else if (isUpdate) {
          // ── UPDATE with NO serials sent → ALLOW IT ──
          // Controller handles using existing serials from DB
          // Quantity can freely change — no restriction here
          console.log(`[Validator]   ℹ️  Update with no serials provided — controller will handle using existing DB serials`);

        } else {
          // ── CREATE with NO serials → ERROR ──
          const msg = `Product "${productDoc.productTitle}" requires serial numbers`;
          console.log(`[Validator]   ❌ ${msg}`);
          throw new Error(msg);
        }

      } else {
        // Product does NOT track serial numbers
        if (hasSerials) {
          const msg = `Product "${productDoc.productTitle}" does not require serial number tracking`;
          console.log(`[Validator]   ❌ ${msg}`);
          throw new Error(msg);
        }
        console.log(`[Validator]   ✅ Non-serialized product — no serials needed`);
      }
    }

    console.log(`[Validator] ✅ All products passed serial validation`);
    return true;
  },
};

// ================================================================
// handleValidationErrors
// ================================================================
export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    console.log("[Validator] ❌ Validation errors:", JSON.stringify(errors.array(), null, 2));
    return res.status(400).json({
      success: false,
      message: "Validation error",
      errors: errors.array().map((error) => ({
        field  : error.path,
        message: error.msg,
        value  : error.value,
      })),
    });
  }
  next();
};

// ================================================================
// validateCreateStockPurchase
// ================================================================
export const validateCreateStockPurchase = [
  body("type")
    .optional()
    .isIn(["new", "refurbish"])
    .withMessage('Type must be either "new" or "refurbish"'),

  body("date")
    .optional()
    .isISO8601()
    .withMessage("Date must be a valid ISO 8601 date"),

  body("invoiceNo")
    .trim()
    .notEmpty()
    .withMessage("Invoice number is required")
    .isLength({ min: 1, max: 100 })
    .withMessage("Invoice number must be between 1 and 100 characters")
    .custom(customValidators.isUniqueInvoice)
    .withMessage("Invoice number already exists"),

  body("vendor")
    .notEmpty()
    .withMessage("Vendor is required")
    .custom(customValidators.isObjectId)
    .withMessage("Invalid vendor ID format")
    .custom(customValidators.vendorExists)
    .withMessage("Vendor not found"),

  body("outlet")
    .optional()
    .custom(customValidators.isObjectId)
    .withMessage("Invalid outlet ID format")
    .custom(customValidators.isValidOutlet)
    .withMessage("Outlet not found or invalid center type"),

  body("transportAmount")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("Transport amount must be a non-negative number"),

  body("cgst")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("CGST must be a non-negative number"),

  body("sgst")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("SGST must be a non-negative number"),

  body("igst")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("IGST must be a non-negative number"),

  body("products")
    .isArray({ min: 1 })
    .withMessage("At least one product is required")
    .custom(customValidators.isValidProducts)
    .withMessage("Each product must have product ID, non-negative price, and quantity ≥ 1")
    .custom((products, { req }) => customValidators.validateSerialNumbers(products, { req })),
  // ⚠️  No .withMessage() here — so the real thrown error message passes through

  body("products.*.product")
    .notEmpty()
    .withMessage("Product ID is required")
    .custom(customValidators.isObjectId)
    .withMessage("Invalid product ID format")
    .custom(customValidators.productExists)
    .withMessage("Product not found"),

  body("products.*.price")
    .isFloat({ min: 0 })
    .withMessage("Price must be a non-negative number"),

  body("products.*.purchasedQuantity")
    .isInt({ min: 1 })
    .withMessage("Purchased quantity must be at least 1"),

  handleValidationErrors,
];

// ================================================================
// validateUpdateStockPurchase
// ================================================================
export const validateUpdateStockPurchase = [
  param("id")
    .custom(customValidators.isObjectId)
    .withMessage("Invalid stock purchase ID format"),

  body("type")
    .optional()
    .isIn(["new", "refurbish"])
    .withMessage('Type must be either "new" or "refurbish"'),

  body("date")
    .optional()
    .isISO8601()
    .withMessage("Date must be a valid ISO 8601 date"),

  body("invoiceNo")
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage("Invoice number must be between 1 and 100 characters")
    .custom(customValidators.isUniqueInvoice)
    .withMessage("Invoice number already exists"),

  body("vendor")
    .optional()
    .custom(customValidators.isObjectId)
    .withMessage("Invalid vendor ID format")
    .custom(customValidators.vendorExists)
    .withMessage("Vendor not found"),

  body("outlet")
    .optional()
    .custom(customValidators.isObjectId)
    .withMessage("Invalid outlet ID format")
    .custom(customValidators.isValidOutlet)
    .withMessage("Outlet not found or invalid center type"),

  body("transportAmount")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("Transport amount must be a non-negative number"),

  body("products")
    .optional()
    .isArray({ min: 1 })
    .withMessage("Products array must contain at least one item")
    .custom(customValidators.isValidProducts)
    .withMessage("Each product must have product ID, non-negative price, and quantity ≥ 1")
    .custom((products, { req }) => customValidators.validateSerialNumbers(products, { req })),
  // ⚠️  No .withMessage() after the serial validator
  //     so the REAL error message from throw new Error(...) passes through to the client
  //     instead of the generic "Serial number validation failed" string

  handleValidationErrors,
];

// ================================================================
// Remaining validators (unchanged)
// ================================================================
export const validateIdParam = [
  param("id").custom(customValidators.isObjectId).withMessage("Invalid ID format"),
  handleValidationErrors,
];

export const validateVendorIdParam = [
  param("vendorId")
    .custom(customValidators.isObjectId).withMessage("Invalid vendor ID format")
    .custom(customValidators.vendorExists).withMessage("Vendor not found"),
  handleValidationErrors,
];

export const validateOutletIdParam = [
  param("outletId")
    .custom(customValidators.isObjectId).withMessage("Invalid outlet ID format")
    .custom(customValidators.isValidOutlet).withMessage("Outlet not found or invalid center type"),
  handleValidationErrors,
];

export const validateCenterIdParam = [
  param("centerId")
    .custom(customValidators.isObjectId).withMessage("Invalid center ID format")
    .custom(customValidators.isValidCenter).withMessage("Center not found or invalid center type"),
  handleValidationErrors,
];

export const validateStockPurchaseQuery = [
  query("page").optional().isInt({ min: 1 }).withMessage("Page must be a positive integer"),
  query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("Limit must be between 1 and 100"),
  query("type").optional().isIn(["new", "refurbish"]).withMessage('Type must be either "new" or "refurbish"'),
  query("vendor").optional().custom(customValidators.isObjectId).withMessage("Invalid vendor ID format"),
  query("outlet").optional().custom(customValidators.isObjectId).withMessage("Invalid outlet ID format"),
  query("startDate").optional().isISO8601().withMessage("Start date must be a valid ISO 8601 date"),
  query("endDate").optional().isISO8601().withMessage("End date must be a valid ISO 8601 date"),
  query("sortBy").optional().isIn(["createdAt", "updatedAt", "date", "invoiceNo", "totalAmount"]).withMessage("Invalid sort field"),
  query("sortOrder").optional().isIn(["asc", "desc"]).withMessage('Sort order must be either "asc" or "desc"'),
  handleValidationErrors,
];

export const validateProductQuery = [
  query("page").optional().isInt({ min: 1 }).withMessage("Page must be a positive integer"),
  query("limit").optional().isInt({ min: 1, max: 100 }).withMessage("Limit must be between 1 and 100"),
  query("search").optional().isLength({ min: 1, max: 100 }).withMessage("Search term must be between 1 and 100 characters"),
  handleValidationErrors,
];

export const validateStockAvailabilityParams = [
  param("outletId")
    .custom(customValidators.isObjectId).withMessage("Invalid outlet ID format")
    .custom(customValidators.isValidOutlet).withMessage("Outlet not found or invalid center type"),
  param("productId")
    .custom(customValidators.isObjectId).withMessage("Invalid product ID format")
    .custom(customValidators.productExists).withMessage("Product not found"),
  handleValidationErrors,
];

export const validateOutletSerialParams = [
  param("outletId")
    .custom(customValidators.isObjectId).withMessage("Invalid outlet ID format")
    .custom(customValidators.isValidOutlet).withMessage("Outlet not found or invalid center type"),
  param("productId")
    .custom(customValidators.isObjectId).withMessage("Invalid product ID format")
    .custom(customValidators.productExists).withMessage("Product not found"),
  handleValidationErrors,
];

export const validateUpdateOutletSerial = [
  ...validateOutletSerialParams,
  param("serialNumber")
    .notEmpty().withMessage("Serial number is required")
    .isLength({ min: 1, max: 100 }).withMessage("Serial number must be between 1 and 100 characters")
    .custom(customValidators.isValidOutletSerial).withMessage("Serial number not found or not available"),
  body("newSerialNumber")
    .notEmpty().withMessage("New serial number is required")
    .isLength({ min: 1, max: 100 }).withMessage("New serial number must be between 1 and 100 characters")
    .custom(customValidators.isUniqueSerial).withMessage("New serial number already exists in the system"),
  handleValidationErrors,
];

export const validateDeleteOutletSerial = [
  ...validateOutletSerialParams,
  param("serialNumber")
    .notEmpty().withMessage("Serial number is required")
    .custom(customValidators.isValidOutletSerial).withMessage("Serial number not found or not available"),
  handleValidationErrors,
];

export const validateBulkOutletSerialOperations = [
  ...validateOutletSerialParams,
  body("serialNumbers")
    .isArray({ min: 1 }).withMessage("Serial numbers array is required with at least one item")
    .custom(customValidators.isValidSerialNumbers).withMessage("Invalid serial numbers provided"),
  handleValidationErrors,
];

export const validateCenterSerialParams = [
  param("centerId")
    .custom(customValidators.isObjectId).withMessage("Invalid center ID format")
    .custom(customValidators.isValidCenter).withMessage("Center not found"),
  param("productId")
    .custom(customValidators.isObjectId).withMessage("Invalid product ID format")
    .custom(customValidators.productExists).withMessage("Product not found"),
  handleValidationErrors,
];

export const validateUpdateCenterSerial = [
  ...validateCenterSerialParams,
  param("serialNumber")
    .notEmpty().withMessage("Serial number is required")
    .isLength({ min: 1, max: 100 }).withMessage("Serial number must be between 1 and 100 characters")
    .custom(customValidators.isValidCenterSerial).withMessage("Serial number not found or not available"),
  body("newSerialNumber")
    .notEmpty().withMessage("New serial number is required")
    .isLength({ min: 1, max: 100 }).withMessage("New serial number must be between 1 and 100 characters")
    .custom(customValidators.isUniqueSerial).withMessage("New serial number already exists in the system"),
  handleValidationErrors,
];

export const validateDeleteCenterSerial = [
  ...validateCenterSerialParams,
  param("serialNumber")
    .notEmpty().withMessage("Serial number is required")
    .custom(customValidators.isValidCenterSerial).withMessage("Serial number not found or not available"),
  handleValidationErrors,
];
