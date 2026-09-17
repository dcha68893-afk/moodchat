module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Friend', {
      id: { type: Sequelize.INTEGER, allowNull: false, autoIncrement: true, primaryKey: true },
      requesterId: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      addresseeId: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      userLowId: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      userHighId: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'pending' },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addConstraint('Friend', { fields: ['userLowId', 'userHighId'], type: 'unique', name: 'friend_pair_unique' });
    await queryInterface.addIndex('Friend', ['addresseeId', 'status'], { name: 'friend_incoming_status_idx' });
    await queryInterface.addIndex('Friend', ['requesterId', 'status'], { name: 'friend_outgoing_status_idx' });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('Friend');
  }
};