// Friends relationship model — rebuilt from scratch.
module.exports = (sequelize, DataTypes) => {
  const Friend = sequelize.define('Friend', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    requesterId: { type: DataTypes.INTEGER, allowNull: false },
    addresseeId: { type: DataTypes.INTEGER, allowNull: false },
    userLowId: { type: DataTypes.INTEGER, allowNull: false },
    userHighId: { type: DataTypes.INTEGER, allowNull: false },
    status: {
      type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pending',
      validate: { isIn: [['pending', 'accepted', 'rejected']] }
    }
  }, {
    tableName: 'Friend',
    timestamps: true,
    indexes: [
      { unique: true, fields: ['userLowId', 'userHighId'], name: 'friend_pair_unique' },
      { fields: ['addresseeId', 'status'], name: 'friend_incoming_status_idx' },
      { fields: ['requesterId', 'status'], name: 'friend_outgoing_status_idx' }
    ],
    hooks: {
      beforeValidate(row) {
        const a = Number(row.requesterId), b = Number(row.addresseeId);
        if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) throw new Error('Friend user IDs must be positive integers');
        if (a === b) throw new Error('A user cannot be their own friend');
        row.userLowId = Math.min(a, b); row.userHighId = Math.max(a, b);
      }
    }
  });
  const Users = sequelize.models.Users;
  if (Users) {
    Friend.belongsTo(Users, { foreignKey: 'requesterId', as: 'requester', constraints: false });
    Friend.belongsTo(Users, { foreignKey: 'addresseeId', as: 'addressee', constraints: false });
  }
  return Friend;
};