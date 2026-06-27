'use strict';
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS group_commitments (
        id SERIAL PRIMARY KEY, "groupId" INTEGER NOT NULL,
        commitment TEXT NOT NULL, "memberCount" INTEGER NOT NULL DEFAULT 0,
        "publishedBy" INTEGER NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_gc_group_ts ON group_commitments("groupId","createdAt" DESC)`);
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS group_delivery_tokens (
        id SERIAL PRIMARY KEY, "groupId" INTEGER NOT NULL, "userId" INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE("groupId","userId")
      )`);
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS group_sealed_invites (
        id SERIAL PRIMARY KEY, "groupId" INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE, "encryptedInvite" TEXT NOT NULL,
        "createdBy" INTEGER NOT NULL, "expiresAt" TIMESTAMPTZ,
        "useCount" INTEGER NOT NULL DEFAULT 0, "maxUses" INTEGER NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    console.log('Phase 4 sealed group tables created');
  },
  async down(queryInterface) {
    for (const t of ['group_sealed_invites','group_delivery_tokens','group_commitments'])
      await queryInterface.dropTable(t, { cascade: true }).catch(() => {});
  },
};
