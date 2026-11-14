export const TOOL={name:'bash',description:'Run a command in this task virtual /workspace. No network or host filesystem.',
 inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false}};
