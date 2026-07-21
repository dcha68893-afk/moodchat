// --- MODEL: GroupSenderKeyGeneration.js ---
// Atomic per-(group, owner) counter for Sender Key generation numbers.
// See migration 20260721_group_sender_key_generation_counter.js for why
// this exists — closes a race where two devices/tabs could both claim the
// same "next" generation number and generate different key material.
module.exports = (sequelize, DataTypes) => {
  const GroupSenderKeyGeneration = sequelize.define(
    'GroupSenderKeyGeneration',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      groupId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      ownerUserId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      currentGeneration: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: 'group_sender_key_generations',
      timestamps: true,
      indexes: [
        { unique: true, fields: ['groupId', 'ownerUserId'] },
      ],
    }
  );

  GroupSenderKeyGeneration.associate = (models) => {
    if (models.Group) {
      GroupSenderKeyGeneration.belongsTo(models.Group, { foreignKey: 'groupId', as: 'group' });
    }
    if (models.User || models.Users) {
      const User = models.User || models.Users;
      GroupSenderKeyGeneration.belongsTo(User, { foreignKey: 'ownerUserId', as: 'owner' });
    }
  };

  // Atomically claim the next generation number for this (groupId, ownerUserId).
  // Guarantees no two concurrent callers ever receive the same number, no
  // matter how many tabs/devices are calling at once — the database, not
  // any client's locally-computed guess, is the single source of truth.
  GroupSenderKeyGeneration.claimNext = async function (groupId, ownerUserId) {
    const [rows] = await sequelize.query(
      `INSERT INTO group_sender_key_generations (group_id, owner_user_id, current_generation, created_at, updated_at)
       VALUES (:groupId, :ownerUserId, 1, NOW(), NOW())
       ON CONFLICT (group_id, owner_user_id)
       DO UPDATE SET current_generation = group_sender_key_generations.current_generation + 1, updated_at = NOW()
       RETURNING current_generation;`,
      { replacements: { groupId, ownerUserId } }
    );
    return rows[0].current_generation;
  };

  return GroupSenderKeyGeneration;
};
