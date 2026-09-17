'use strict';
const { Op } = require('sequelize');

/** Canonical Friends model. Maps application fields to friends.requester_id
 * and friends.receiver_id, which is the repaired production schema. */
module.exports = (sequelize, DataTypes) => {
  const Friend = sequelize.define('Friend', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    requesterId: { type: DataTypes.INTEGER, allowNull: false, field: 'requester_id' },
    addresseeId: { type: DataTypes.INTEGER, allowNull: false, field: 'receiver_id' },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pending' },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    acceptedAt: { type: DataTypes.DATE, allowNull: true, field: 'accepted_at' },
    blockedAt: { type: DataTypes.DATE, allowNull: true, field: 'blocked_at' },
    notes: { type: DataTypes.STRING(200), allowNull: true },
    category: { type: DataTypes.STRING(50), allowNull: true },
    closenessLevel: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0, field: 'closeness_level' },
    isPinned: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false, field: 'is_pinned' },
    isMuted: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false, field: 'is_muted' },
    expiresAt: { type: DataTypes.DATE, allowNull: true, field: 'expires_at' },
    isBusiness: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false, field: 'is_business' },
    requestMessage: { type: DataTypes.STRING(300), allowNull: true, field: 'request_message' },
    snoozedUntil: { type: DataTypes.DATE, allowNull: true, field: 'snoozed_until' },
    isRestricted: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false, field: 'is_restricted' }
  }, { tableName: 'friends', modelName: 'Friend', timestamps: true, freezeTableName: true });

  Friend.prototype.accept = async function () { this.status='accepted'; this.acceptedAt=new Date(); return this.save(); };
  Friend.prototype.reject = async function () { this.status='rejected'; return this.save(); };
  Friend.prototype.block = async function () { this.status='blocked'; this.blockedAt=new Date(); return this.save(); };
  Friend.prototype.unblock = async function () { this.blockedAt=null; return this.destroy(); };

  Friend.getFriendship = function (a,b) { return this.findOne({ where:{ [Op.or]:[{requesterId:a,addresseeId:b},{requesterId:b,addresseeId:a}] } }); };
  Friend.getUserFriends = async function (userId,status='accepted') {
    const Users=this.sequelize.models.Users; if(!Users)return[];
    const [a,b]=await Promise.all([
      this.findAll({where:{requesterId:userId,status}}),
      this.findAll({where:{addresseeId:userId,status}})
    ]);
    const rows=[...a,...b];
    const ids=[...new Set(rows.map(r=>r.requesterId===userId?r.addresseeId:r.requesterId))];
    if(!ids.length)return[];
    const users=await Users.findAll({where:{id:ids},attributes:['id','username','firstName','lastName','avatar','status','lastSeen']});
    const byId=new Map(users.map(u=>[u.id,u]));
    return rows.map(r=>({friend:r, user:byId.get(r.requesterId===userId?r.addresseeId:r.requesterId)||null}));
  };
  Friend.getPendingRequests=function(userId){return this.findAll({where:{addresseeId:userId,status:'pending'},order:[['createdAt','DESC']]});};
  Friend.getSentRequests=function(userId){return this.findAll({where:{requesterId:userId,status:'pending'},order:[['createdAt','DESC']]});};

  Friend.associate=function(models){
    if(!models.Users)return;
    Friend.belongsTo(models.Users,{foreignKey:{name:'requesterId',field:'requester_id'},targetKey:'id',as:'requester',constraints:false});
    Friend.belongsTo(models.Users,{foreignKey:{name:'addresseeId',field:'receiver_id'},targetKey:'id',as:'addressee',constraints:false});
    Friend.belongsTo(models.Users,{foreignKey:{name:'requesterId',field:'requester_id'},targetKey:'id',as:'friendRequesterUser',constraints:false});
    Friend.belongsTo(models.Users,{foreignKey:{name:'addresseeId',field:'receiver_id'},targetKey:'id',as:'friendAddresseeUser',constraints:false});
  };
  return Friend;
};