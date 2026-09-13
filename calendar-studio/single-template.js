/* Each templates/*.html is a reusable edition. Edit its JSON data to populate it. */
(() => {
  const T=CalendarTemplates,config=JSON.parse(document.getElementById('template-data').textContent);
  const host=document.getElementById('calendar');
  const render=()=>{host.style.transform='none';T.render(host,config.template,config.fields,config.options);const scale=Math.min(1,(innerWidth-32)/T.WIDTH);host.style.transform=`scale(${scale})`;document.getElementById('frame').style.cssText=`width:${T.WIDTH*scale}px;height:${T.HEIGHT*scale}px`;};
  const style=document.createElement('style');style.textContent='body{margin:0;background:#e9edef;font:13px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#354047}header{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:18px 24px}header a{color:#315f75}button{background:#315f75;color:white;border:0;border-radius:3px;padding:10px 18px;cursor:pointer}#frame{margin:0 auto 25px;position:relative;box-shadow:0 5px 24px #24323d20}#calendar{position:absolute;inset:0;width:1122px;height:1402px;transform-origin:top left}#status{font-size:12px;padding:0 24px 16px;text-align:center}@media print{header,#status{display:none}body{background:white}#frame{margin:0!important;width:1122px!important;height:1402px!important;box-shadow:none}#calendar{transform:none!important}@page{size:1122px 1402px;margin:0}}';document.head.append(style);
  document.getElementById('title').textContent=T.names[config.template];document.getElementById('edit').href=`../index.html?template=${config.template}`;
  document.getElementById('export').addEventListener('click',async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{const blob=await T.createPNG(config.template,config.fields,{...config.options,scale:2});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`日历-${config.template+1}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),15000);document.getElementById('status').textContent='已导出 2244 × 2804 PNG';}
    catch(error){document.getElementById('status').textContent=error.message;}finally{button.disabled=false;}
  });
  render();document.fonts.ready.then(render);window.addEventListener('resize',render);
})();
