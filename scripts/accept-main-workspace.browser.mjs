// Playwright CLI run-code function. Use only with the owned controlled backend.
async page => {
 const origin='http://127.0.0.1:4517';
 const cap=await (await page.request.get(origin+'/buyer-api/capabilities')).json();
 if(cap.taskRuntime!=='client-memory-v1'||cap.network!=='testnet'||cap.realInferencePayments!==false||cap.nativeFunding!==false)throw Error('owned_controlled_workspace_required');
 const errors=[],legacy=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.__storageAttempts=[];window.__procureCalls=[];window.__grantBodies=[];
  for(const name of ['indexedDB','localStorage','sessionStorage'])Object.defineProperty(window,name,{get(){window.__storageAttempts.push(name);throw Error('persistent_storage_forbidden');},configurable:true});
  const original=window.fetch;window.fetch=(url,init)=>{const path=String(url);if(path.includes('/procure'))window.__procureCalls.push(JSON.parse(init.body).logicalCallId);if(path.endsWith('/authorizations')&&init?.body)window.__grantBodies.push(JSON.parse(init.body));return original(url,init);};
 });
 await page.route(/\/buyer-api\/(sessions\/|agents\/[^/]+\/tasks|calls\/)/,route=>{legacy.push(route.request().url());return route.abort();});
 await page.context().addCookies([{name:'auction_owner',value:'controlled-review',url:origin,httpOnly:true,sameSite:'Strict'}]);
 await page.goto(origin+'/');
 await page.getByRole('region',{name:'a task',exact:true}).getByRole('button',{name:/^Run /}).waitFor();
 await page.getByText('controlled local stack',{exact:true}).waitFor();
 await page.getByRole('button',{name:/Market deployment and channel/}).click();
 const financial=()=>page.evaluate(async()=> (await(await fetch('/buyer-api/orders')).json()).orders);
 const initial=await financial();
 await page.locator('.window-list button').first().click();
 await page.getByRole('button',{name:'Configure task',exact:true}).click();
 const settings=page.getByRole('dialog',{name:'a · task settings',exact:true});
 await settings.getByRole('textbox',{name:'task cap USD · virtual funds',exact:true}).fill('0.02');
 await settings.getByRole('textbox',{name:'starting bid · multiplier',exact:true}).fill('1.1');
 await settings.getByRole('textbox',{name:'economic bid ceiling · multiplier',exact:true}).fill('1.5');
 await settings.getByRole('button',{name:'apply ↵',exact:true}).click();
 await page.getByRole('button',{name:'run all',exact:true}).click();
 for(const agent of ['a','b'])await page.getByRole('status',{name:agent+' procurement status',exact:true}).filter({hasText:'Task complete · artifact verified'}).waitFor();
 let orders=[];
 for(let n=0;n<100;n++){orders=await financial();if(orders.length===initial.length+4&&orders.every(o=>o.settlementState==='refund_confirmed'))break;await new Promise(r=>setTimeout(r,25));}
 if(orders.length!==initial.length+4)throw Error('four_original_orders_required');
 const fresh=orders.filter(o=>!initial.some(old=>old.orderId===o.orderId));
 for(const order of fresh){if(order.settlementState!=='refund_confirmed'||BigInt(order.principal.charged)+BigInt(order.principal.refunded)!==BigInt(order.principal.prepaid)||order.result!==undefined||order.challenge!==undefined)throw Error('financial_projection_or_conservation_failed');
  if(order.contract.bidMultiplier!==(order.agentId==='a'?'1100000':'1000000'))throw Error('bid_and_cap_not_independent');}
 await page.getByRole('button',{name:'activity',exact:true}).click();
 await page.getByRole('tab',{name:'workspace',exact:true}).click();
 await page.getByRole('tabpanel').getByText('{"sum":42,"count":3}',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Zoom selected pane',exact:true}).click();
 await page.getByRole('button',{name:'Restore panes',exact:true}).click();
 await page.getByRole('tab',{name:'orders & bids',exact:true}).click();
 await page.screenshot({path:'output/playwright/main-workspace-orders.png'});
 await page.getByRole('button',{name:'New task',exact:true}).click();
 const create=page.getByRole('dialog',{name:'new task',exact:true});
 await create.getByRole('combobox',{name:'agent',exact:true}).selectOption('b');
 await create.getByRole('combobox',{name:'buyer strategy',exact:true}).selectOption('task-aware');
 await create.getByRole('button',{name:'create task ↵',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.pane-slot').length===3);
 const pane=page.locator('.pane-slot').last();
 let held=false,release=false;
 await page.route('**/buyer-api/procure',async route=>{const response=await route.fetch();if(response.status()===200&&!held){held=true;while(!release)await new Promise(r=>setTimeout(r,20));}await route.fulfill({response});});
 try{
  await pane.getByRole('button',{name:/^Run /}).click();
  for(let n=0;n<150&&!held;n++)await new Promise(r=>setTimeout(r,40));
  if(!held)throw Error('original_response_not_held');
  await page.locator('.route-view:not([hidden])').getByRole('link',{name:'proposal',exact:true}).click();
  await page.waitForURL(origin+'/proposal');
  await page.keyboard.press('Control+k');
  if(await page.getByRole('dialog').count())throw Error('hidden_workspace_shortcut');
  await page.locator('.route-view:not([hidden])').getByRole('link',{name:'try',exact:true}).click();
  await page.waitForURL(origin+'/');
  await page.getByRole('spinbutton',{name:'Pane count',exact:true}).fill('2');
  await page.waitForFunction(()=>document.querySelectorAll('.pane-slot').length===2);
  release=true;
  for(let n=0;n<150;n++){if((await financial()).length===initial.length+6)break;await new Promise(r=>setTimeout(r,40));}
  await page.getByRole('spinbutton',{name:'Pane count',exact:true}).fill('3');
  await page.waitForFunction(()=>document.querySelectorAll('.pane-slot').length===3);
  await page.locator('.pane-slot').last().getByText('complete',{exact:true}).waitFor();
 }finally{release=true;await page.unroute('**/buyer-api/procure');}
 await page.locator('.window-list button').last().click();
 await page.getByRole('tab',{name:'workspace',exact:true}).click();
 await page.getByRole('tabpanel').getByText('{"sum":19,"count":3}',{exact:true}).waitFor();
 await page.getByRole('button',{name:'owner-1',exact:true}).click();
 const wallet=page.getByRole('dialog',{name:'NEAR wallets · testnet',exact:true});
 await wallet.waitFor();if(await wallet.getByRole('button',{name:/fund from owner/}).count())throw Error('unapproved_funding_control');
 await wallet.getByRole('button',{name:'Close dialog',exact:true}).click();
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'export evidence',exact:true}).click();
 await (await downloadPromise).saveAs('output/playwright/main-task-evidence.json');
 const before=await page.evaluate(()=>({calls:[...new Set(window.__procureCalls)],storage:window.__storageAttempts,grantBodies:window.__grantBodies}));
 if(before.calls.length!==6||before.storage.length||before.grantBodies.length!==3||before.grantBodies.some(g=>Object.keys(g).sort().join(',')!=='agentId,budgetNano,callCapMicro,deadlineMs,operation'))throw Error('session_state_or_duplicate_purchase');
 await page.reload();
 await page.getByRole('region',{name:'a task',exact:true}).getByText('ready',{exact:true}).waitFor();
 await page.getByRole('button',{name:'activity',exact:true}).click();
 await page.getByRole('region',{name:'Task activity',exact:true}).getByText('Previous orders remain available after refresh.',{exact:false}).waitFor();
 await page.getByRole('tab',{name:'workspace',exact:true}).click();
 if(await page.getByRole('tabpanel').getByText('/workspace/result.json',{exact:true}).count())throw Error('tool_workspace_restored');
 const after=await page.evaluate(async()=>({calls:window.__procureCalls,storage:window.__storageAttempts,orders:(await(await fetch('/buyer-api/orders')).json()).orders.length}));
 if(after.calls.length||after.storage.length||after.orders!==initial.length+6||legacy.length||errors.length)throw Error('refresh_or_legacy_api_regression:'+JSON.stringify({after,legacy,errors}));
 await page.getByRole('button',{name:/Market deployment and channel/}).click();
 await page.setViewportSize({width:390,height:844});
 // Let wterm finish its ResizeObserver reflow before capturing the mobile terminal.
 await page.waitForTimeout(500);
 await page.screenshot({path:'output/playwright/main-workspace-mobile.png'});
 const mobile=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth}));
 if(mobile.documentWidth>mobile.width+1)throw Error('mobile_horizontal_overflow:'+JSON.stringify(mobile));
 const proposalBounds=await page.locator('.app-header').getByRole('link',{name:'proposal',exact:true}).boundingBox(),helpBounds=await page.getByRole('button',{name:'Keyboard shortcuts',exact:true}).boundingBox();
 if(proposalBounds.x+proposalBounds.width>helpBounds.x)throw Error('mobile_navigation_overlap');
 await page.setViewportSize({width:1280,height:900});
 await page.goto(origin+'/memory');await page.waitForURL(origin+'/');
 if((await financial()).length!==after.orders)throw Error('compatibility_redirect_rebought');
 return {scope:'controlled-main-workspace-real-chromium-wasm',mainRoute:'/',standalonePageRemoved:true,completeTasks:3,originalModelCalls:before.calls.length,originalOrders:fresh.length+2,
  independentArtifacts:[42,19,19],hiddenTaskCompleted:true,workspaceRetained:true,proposalNavigationRetainsTask:true,attestationPreserved:true,ownerLogin:'owned fixture cookie; NEP-413 separately verified in PG tests',
  browserStorageAttempts:0,legacyTaskApiCalls:0,financialOnlyGrantBodies:true,refreshAutoPurchases:0,historicalOrdersAfterRefresh:after.orders,mobile,realChainPayments:false,realInference:false};
}
