// Get the center ID
var centerId = ObjectId("69217f7b688830141da10532");

print("Deleting stock data for center:", centerId);

// Delete all collections
var result1 = db.centerstocks.deleteMany({ center: centerId });
print("centerstocks deleted:", result1.deletedCount);

var result2 = db.stocktransfers.deleteMany({ 
    $or: [
        { fromCenter: centerId },
        { toCenter: centerId }
    ]
});
print("stocktransfers deleted:", result2.deletedCount);

var result3 = db.stockrequests.deleteMany({ 
    $or: [
        { center: centerId },
        { warehouse: centerId }
    ]
});
print("stockrequests deleted:", result3.deletedCount);

var result4 = db.stockusages.deleteMany({ 
    $or: [
        { center: centerId },
        { toCenter: centerId }
    ]
});
print("stockusages deleted:", result4.deletedCount);

var result5 = db.centerreturns.deleteMany({ center: centerId });
print("centerreturns deleted:", result5.deletedCount);

var result6 = db.outletstocks.deleteMany({ outlet: centerId });
print("outletstocks deleted:", result6.deletedCount);

var result7 = db.entitystocks.deleteMany({ center: centerId });
print("entitystocks deleted:", result7.deletedCount);

var result8 = db.faultystocks.deleteMany({ 
    $or: [
        { center: centerId },
        { toCenter: centerId }
    ]
});
print("faultystocks deleted:", result8.deletedCount);

var result9 = db.repairtransfers.deleteMany({ 
    $or: [
        { fromCenter: centerId },
        { toCenter: centerId }
    ]
});
print("repairtransfers deleted:", result9.deletedCount);

var result10 = db.testingstocks.deleteMany({ center: centerId });
print("testingstocks deleted:", result10.deletedCount);

var result11 = db.resellerstocks.deleteMany({ center: centerId });
print("resellerstocks deleted:", result11.deletedCount);

print("Successfully deleted all stock data for center!");
