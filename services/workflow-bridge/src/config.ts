export const config = {
  port: parseInt(process.env.PORT || '8011', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://trialo:trialo_dev@localhost:5432/trialo',
  jwtSecret: process.env.JWT_SECRET || '',
  kafkaBrokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
  zeebeAddress: process.env.ZEEBE_ADDRESS || 'localhost:26500',
  agentRuntimeUrl: process.env.AGENT_RUNTIME_URL || 'http://localhost:8004',
  formEngineUrl: process.env.FORM_ENGINE_URL || 'http://localhost:8010',
  notificationServiceUrl: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:8006',
  auditServiceUrl: process.env.AUDIT_SERVICE_URL || 'http://localhost:8002',
};
