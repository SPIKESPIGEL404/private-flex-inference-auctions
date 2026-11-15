import {prepareTestnetRun} from '../services/mpp-near-direct/auction/testnet-plan.mjs';
const [privateDirectory,publicPlanFile]=process.argv.slice(2);
if(!privateDirectory||!publicPlanFile)throw Error('usage_private_directory_public_plan_file');
console.log(JSON.stringify(await prepareTestnetRun(privateDirectory,publicPlanFile)));
