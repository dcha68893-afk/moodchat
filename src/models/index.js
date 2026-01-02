const { Op } = require('sequelize');
const { Sequelize } = require('sequelize');
const config = require('../config');
const databaseConfig = require('../config/database');

const env = config.nodeEnv || 'development';
const dbConfig = databaseConfig[env];

const sequelize = new Sequelize(dbConfig.name, dbConfig.user, dbConfig.password, {
  host: dbConfig.host,
  port: dbConfig.port,
  dialect: dbConfig.dialect,
  logging: dbConfig.logging,
  pool: dbConfig.pool,
  define: {
    timestamps: true,
    underscored: true,
    paranoid: false,
  },
});

// Import models
const User = require('./User')(sequelize, Sequelize.DataTypes);
const Profile = require('./Profile')(sequelize, Sequelize.DataTypes);
const Friend = require('./Friend')(sequelize, Sequelize.DataTypes);
const Chat = require('./Chat')(sequelize, Sequelize.DataTypes);
const Group = require('./Group')(sequelize, Sequelize.DataTypes);
const Message = require('./Message')(sequelize, Sequelize.DataTypes);
const ReadReceipt = require('./ReadReceipt')(sequelize, Sequelize.DataTypes);
const TypingIndicator = require('./TypingIndicator')(sequelize, Sequelize.DataTypes);
const Call = require('./Call')(sequelize, Sequelize.DataTypes);
const Mood = require('./Mood')(sequelize, Sequelize.DataTypes);
const Media = require('./Media')(sequelize, Sequelize.DataTypes);
const Notification = require('./Notification')(sequelize, Sequelize.DataTypes);

// Define associations

// User - Profile (One-to-One)
User.hasOne(Profile, { foreignKey: 'userId', as: 'profile' });
Profile.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// User - Friend (Many-to-Many through Friend table)
User.belongsToMany(User, {
  through: Friend,
  as: 'friends',
  foreignKey: 'requesterId',
  otherKey: 'receiverId',
});
User.belongsToMany(User, {
  through: Friend,
  as: 'friendOf',
  foreignKey: 'receiverId',
  otherKey: 'requesterId',
});

Friend.belongsTo(User, { foreignKey: 'requesterId', as: 'requester' });
Friend.belongsTo(User, { foreignKey: 'receiverId', as: 'receiver' });

// User - Chat (Many-to-Many through ChatParticipant)
const ChatParticipant = sequelize.define(
  'ChatParticipant',
  {
    id: {
      type: Sequelize.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    chatId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    userId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    role: {
      type: Sequelize.ENUM('owner', 'admin', 'moderator', 'member'),
      defaultValue: 'member',
      allowNull: false,
    },
    joinedAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW,
    },
    leftAt: {
      type: Sequelize.DATE,
      allowNull: true,
    },
    notificationsMuted: {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    customSettings: {
      type: Sequelize.JSONB,
      defaultValue: {},
      allowNull: false,
    },
  },
  {
    tableName: 'chat_participants',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['chat_id', 'user_id'],
        unique: true,
      },
      {
        fields: ['chat_id'],
      },
      {
        fields: ['user_id'],
      },
    ],
  }
);

User.belongsToMany(Chat, {
  through: ChatParticipant,
  as: 'chats',
  foreignKey: 'userId',
});
Chat.belongsToMany(User, {
  through: ChatParticipant,
  as: 'participants',
  foreignKey: 'chatId',
});

ChatParticipant.belongsTo(User, { foreignKey: 'userId' });
ChatParticipant.belongsTo(Chat, { foreignKey: 'chatId' });

// Chat - Group (One-to-One)
Chat.hasOne(Group, { foreignKey: 'chatId', as: 'group' });
Group.belongsTo(Chat, { foreignKey: 'chatId', as: 'chat' });

// Chat - Message (One-to-Many)
Chat.hasMany(Message, { foreignKey: 'chatId', as: 'messages' });
Message.belongsTo(Chat, { foreignKey: 'chatId', as: 'chat' });

// User - Message (One-to-Many)
User.hasMany(Message, { foreignKey: 'senderId', as: 'sentMessages' });
Message.belongsTo(User, { foreignKey: 'senderId', as: 'sender' });

// Message - Message (Self-referential for replies)
Message.belongsTo(Message, { foreignKey: 'replyToId', as: 'replyTo' });
Message.hasMany(Message, { foreignKey: 'replyToId', as: 'replies' });

// Message - ReadReceipt (One-to-Many)
Message.hasMany(ReadReceipt, { foreignKey: 'messageId', as: 'readReceipts' });
ReadReceipt.belongsTo(Message, { foreignKey: 'messageId', as: 'message' });

// User - ReadReceipt (One-to-Many)
User.hasMany(ReadReceipt, { foreignKey: 'userId', as: 'readReceipts' });
ReadReceipt.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Chat - TypingIndicator (One-to-Many)
Chat.hasMany(TypingIndicator, { foreignKey: 'chatId', as: 'typingIndicators' });
TypingIndicator.belongsTo(Chat, { foreignKey: 'chatId', as: 'chat' });

// User - TypingIndicator (One-to-Many)
User.hasMany(TypingIndicator, { foreignKey: 'userId', as: 'typingIndicators' });
TypingIndicator.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Chat - Call (One-to-Many)
Chat.hasMany(Call, { foreignKey: 'chatId', as: 'calls' });
Call.belongsTo(Chat, { foreignKey: 'chatId', as: 'chat' });

// User - Call (One-to-Many as initiator)
User.hasMany(Call, { foreignKey: 'initiatorId', as: 'initiatedCalls' });
Call.belongsTo(User, { foreignKey: 'initiatorId', as: 'initiator' });

// User - Mood (One-to-Many)
User.hasMany(Mood, { foreignKey: 'userId', as: 'moods' });
Mood.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// SharedMood model for sharing moods with friends
const SharedMood = sequelize.define(
  'SharedMood',
  {
    id: {
      type: Sequelize.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    moodId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    userId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    sharedWithId: {
      type: Sequelize.INTEGER,
      allowNull: false,
    },
    sharedAt: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.NOW,
    },
    isViewed: {
      type: Sequelize.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    viewedAt: {
      type: Sequelize.DATE,
      allowNull: true,
    },
  },
  {
    tableName: 'shared_moods',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['mood_id', 'shared_with_id'],
        unique: true,
      },
      {
        fields: ['user_id'],
      },
      {
        fields: ['shared_with_id'],
      },
    ],
  }
);

Mood.hasMany(SharedMood, { foreignKey: 'moodId', as: 'sharedWith' });
SharedMood.belongsTo(Mood, { foreignKey: 'moodId', as: 'mood' });
User.hasMany(SharedMood, { foreignKey: 'userId', as: 'sharedMoods' });
SharedMood.belongsTo(User, { foreignKey: 'userId', as: 'user' });
User.hasMany(SharedMood, { foreignKey: 'sharedWithId', as: 'receivedMoods' });
SharedMood.belongsTo(User, { foreignKey: 'sharedWithId', as: 'sharedWith' });

// User - Media (One-to-Many)
User.hasMany(Media, { foreignKey: 'userId', as: 'media' });
Media.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// Message - Media (One-to-One)
Message.hasOne(Media, { foreignKey: 'messageId', as: 'media' });
Media.belongsTo(Message, { foreignKey: 'messageId', as: 'message' });

// User - Notification (One-to-Many)
User.hasMany(Notification, { foreignKey: 'userId', as: 'notifications' });
Notification.belongsTo(User, { foreignKey: 'userId', as: 'user' });

module.exports = {
  sequelize,
  Sequelize,
  User,
  Profile,
  Friend,
  Chat,
  ChatParticipant,
  Group,
  Message,
  ReadReceipt,
  TypingIndicator,
  Call,
  Mood,
  SharedMood,
  Media,
  Notification,
};
