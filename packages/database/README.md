# Database package

This package owns the Prisma schema, future migrations, and the relational access boundary. BBX-001 intentionally defines no domain models.

Later runtime and migration tasks will use:

- `DATABASE_URL`: the pooled PostgreSQL connection used by deployed application processes.
- `DIRECT_URL`: the direct PostgreSQL connection reserved for migrations and other operations that require a session connection.

The bootstrap schema does not read either variable, so Prisma generation, validation, builds, and tests do not require live credentials. Connection wiring belongs to the task that introduces the first database model.
