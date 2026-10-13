'use strict';
const { fixture }=require('./phase-stats');
function create(setCode){return {name:'play-'+setCode,expectedPlayed:setCode,extraCodes:[setCode],plan:[[setCode,setCode==='ASH_236'?'own':'enemy']],chooseAction:({eg,pid,actions,atWindow})=>!atWindow&&(eg.player(pid).promptState.selectedCards??[]).length>0?actions.find(a=>a.arg==='done'):undefined};}
module.exports={create,fixture};
