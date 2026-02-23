async function connectDatabase({ mongoose, mongoUri, jobModel }) {
  const resolvedMongoUri = mongoUri || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/IndianWorker";

  await mongoose.connect(resolvedMongoUri);
  console.log("MongoDB Connected");

  try {
    const indexes = await jobModel.collection.getIndexes();
    if (indexes.id_1) {
      await jobModel.collection.dropIndex("id_1");
      console.log("Dropped old 'id' index from jobs collection");
    }
  } catch (err) {
    console.warn("Note: Could not drop old id index (may not exist):", err.message);
  }
}

module.exports = {
  connectDatabase,
};

