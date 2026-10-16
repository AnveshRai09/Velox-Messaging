// Test configuration. Points at local/CI services, never at production.
process.env.JWT_SECRET = "test-jwt-secret";
process.env.MONGO_TEST_URI =
  process.env.MONGO_TEST_URI ?? "mongodb://127.0.0.1:27017";
