'use strict';
module.exports=(sequelize,DataTypes)=>{
 const MoneyCircleMember=sequelize.define('MoneyCircleMember',{
  id:{type:DataTypes.UUID,defaultValue:DataTypes.UUIDV4,primaryKey:true},
  circleId:{type:DataTypes.UUID,allowNull:false,field:'circle_id'},
  userId:{type:DataTypes.INTEGER,allowNull:false,field:'user_id'},
  role:{type:DataTypes.ENUM('owner','member'),defaultValue:'member'},
  status:{type:DataTypes.ENUM('active','invited','left'),defaultValue:'active'},
  createdAt:{type:DataTypes.DATE,field:'createdAt'},updatedAt:{type:DataTypes.DATE,field:'updatedAt'}
 },{tableName:'money_circle_members',timestamps:true,underscored:true,indexes:[{unique:true,fields:['circle_id','user_id']}]});
 MoneyCircleMember.associate=models=>{if(models.MoneyCircle)MoneyCircleMember.belongsTo(models.MoneyCircle,{foreignKey:'circleId',as:'circle',constraints:false});};
 return MoneyCircleMember;
};