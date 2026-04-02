export const config = {
  port: parseInt(process.env.PORT || '8009', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://trialo:trialo_dev@localhost:5432/trialo',
  mongoUrl: process.env.MONGO_URL || 'mongodb://trialo:trialopass@localhost:27017/trialo?authSource=admin',
  jwtSecret: process.env.JWT_SECRET || '',
  fieldEncryptionKey: process.env.FIELD_ENCRYPTION_KEY || '',
  kafkaBrokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  authServiceUrl: process.env.AUTH_SERVICE_URL || 'http://localhost:8001',
  auditServiceUrl: process.env.AUDIT_SERVICE_URL || 'http://localhost:8002',
  marketplaceUrl: process.env.MARKETPLACE_URL || 'http://localhost:8005',
  agentRuntimeUrl: process.env.AGENT_RUNTIME_URL || 'http://localhost:8004',
  workflowBridgeUrl: process.env.WORKFLOW_BRIDGE_URL || 'http://localhost:8011',
  platformOrgId: '00000000-0000-0000-0000-000000000000',
};
