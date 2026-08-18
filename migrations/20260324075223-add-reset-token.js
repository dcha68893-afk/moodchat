module.exports = {
  async up(queryInterface, Sequelize) {
    // FIX (PROD-SCHEMA-DRIFT / RESET-TOKEN-ALREADY-EXISTS): this project's
    // own in-app runtime migration system (models/index.js) already adds
    // resetToken/resetTokenExpiry to Users on every server boot, and that
    // runs BEFORE `npx sequelize-cli db:migrate` gets a chance to on some
    // deploys (see server.js boot order). A bare addColumn call then fails
    // with "column resetToken already exists" — a hard failure in the
    // strict production migrate path that silently blocked every migration
    // after it (marketplace tables, chats/chat_participants,
    // offline_message_queue, message perf/lifecycle fields, etc.).
    // Reproduced against a real deploy. Now checks first.
    const cols = await queryInterface.describeTable('Users');
    if (!cols.resetToken) {
      await queryInterface.addColumn('Users', 'resetToken', {
        type: Sequelize.STRING,
        allowNull: true
      });
    }
    if (!cols.resetTokenExpiry) {
      await queryInterface.addColumn('Users', 'resetTokenExpiry', {
        type: Sequelize.DATE,
        allowNull: true
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Users', 'resetToken').catch(() => {});
    await queryInterface.removeColumn('Users', 'resetTokenExpiry').catch(() => {});
  }
};