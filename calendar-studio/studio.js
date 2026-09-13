(() => {
  'use strict';
  const T=window.CalendarTemplates, $=id=>document.getElementById(id);
  const storageKey='paper-days-draft-v1';
  const labels={month:'月份',day:'日',weekday:'星期',fullDate:'完整日期',weekNo:'周数',dayOfYear:'年内天数',year:'年份',quote:'摘句',bookTitle:'书名 / 出处',author:'作者',footer:'页脚',issue:'期号'};
  const decorativeLabels={left:'左侧小字',right:'右侧小字',topLeft:'左上小字',topRight:'右上小字',topCenter:'顶部标语',middle:'中部标语',bottomLeft:'左下小字',bottomRight:'右下小字',bottom:'底部标语',center:'中央标语',quoteHeader:'摘句栏标题',quoteTagline:'摘句栏标语',spineLeft:'左侧竖排',spineRight:'右侧竖排'};
  const initial=()=>({version:1,template:0,date:'2026-09-13',fields:{...T.defaults},texture:25,decorative:{},scale:2});
  let state=initial(), placeholderMode=false, zoomed=false, toastTimer;
  function validate(raw) {
    if(!raw || raw.version!==1 || !raw.fields || typeof raw.fields!=='object') throw new Error('配置格式不正确，请选择从纸日导出的 JSON 文件');
    if(!Number.isInteger(raw.template)||raw.template<0||raw.template>4) throw new Error('模板编号无效');
    if(raw.date) T.dateFields(raw.date);
    const next=initial();next.template=raw.template;next.date=raw.date||next.date;
    for(const key of Object.keys(T.placeholders)) if(typeof raw.fields[key]==='string') next.fields[key]=raw.fields[key].slice(0,key==='quote'?1200:240);
    next.texture=Math.max(0,Math.min(70,Number(raw.texture)||0));next.scale=[1,2,3].includes(Number(raw.scale))?Number(raw.scale):2;
    if(raw.decorative && typeof raw.decorative==='object') for(let i=0;i<5;i++) {
      if(!raw.decorative[i]||typeof raw.decorative[i]!=='object')continue;
      next.decorative[i]={};for(const key of Object.keys(T.decorativeDefaults[i])) if(typeof raw.decorative[i][key]==='string')next.decorative[i][key]=raw.decorative[i][key].slice(0,400);
    }
    return next;
  }
  try { const saved=localStorage.getItem(storageKey);if(saved)state=validate(JSON.parse(saved)); } catch { $('save-status').textContent='新草稿'; }
  const requestedTemplate=new URLSearchParams(location.search).get('template');
  if(requestedTemplate!==null && /^[0-4]$/.test(requestedTemplate))state.template=Number(requestedTemplate);
  function save(){try{localStorage.setItem(storageKey,JSON.stringify(state));$('save-status').textContent='草稿已保存';}catch{$('save-status').textContent='请下载配置保存';}}
  function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4200);}
  function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);}
  const currentFields=()=>placeholderMode?{}:state.fields;
  const options=()=>({texture:state.texture/100,decorative:state.decorative[state.template]||{},scale:state.scale});
  const fileName=ext=>`纸日-${String(state.template+1).padStart(2,'0')}-${state.date}${placeholderMode?'-占位符':''}.${ext}`;

  for(const key of ['month','day','weekday','fullDate','weekNo','dayOfYear','year']) {
    const label=document.createElement('label');label.textContent=labels[key];
    const input=document.createElement('input');input.type='text';input.id=key;input.maxLength=100;input.placeholder=T.placeholders[key];label.append(input);$('date-fields').append(label);
  }
  T.names.forEach((name,i)=>{
    const button=document.createElement('button');button.className='template-button';button.type='button';button.dataset.template=i;button.setAttribute('aria-label',`选择${name}`);
    button.innerHTML=`<div class="mini-frame"><div class="mini-poster"></div></div><span class="template-label"><small>0${i+1}</small>${name}</span>`;
    T.render(button.querySelector('.mini-poster'),i,{}, {texture:.25});
    button.addEventListener('click',()=>{state.template=i;renderDecorative();render();save();});$('template-grid').append(button);
  });
  function renderDecorative(){
    $('decorative-fields').replaceChildren();
    const values={...T.decorativeDefaults[state.template],...state.decorative[state.template]};
    for(const [key,value] of Object.entries(values)){
      const label=document.createElement('label');label.textContent=decorativeLabels[key]||key;
      const input=document.createElement('textarea');input.rows=2;input.maxLength=400;input.value=value;
      input.addEventListener('input',()=>{state.decorative[state.template]??={};state.decorative[state.template][key]=input.value;render();save();});
      label.append(input);$('decorative-fields').append(label);
    }
  }
  function syncInputs(){
    for(const key of Object.keys(labels)){$(key).value=state.fields[key];$(key).placeholder=T.placeholders[key];}
    $('date').value=state.date;$('texture').value=state.texture;$('export-scale').value=state.scale;
    renderDecorative();
  }
  function resize(){
    const scroll=$('preview-scroll');
    const scale=zoomed?Math.min(1,(scroll.clientWidth-30)/T.WIDTH*1.65):Math.min((scroll.clientWidth-30)/T.WIDTH,(scroll.clientHeight-28)/T.HEIGHT,1);
    $('preview-frame').style.width=`${T.WIDTH*scale}px`;$('preview-frame').style.height=`${T.HEIGHT*scale}px`;$('preview').style.transform=`scale(${scale})`;
    document.querySelectorAll('.mini-poster').forEach(el=>{el.style.transform='none';T.fit(el);el.style.transform=`scale(${(el.parentElement.clientWidth-4)/T.WIDTH})`;});
  }
  function render(){
    // Fit at native dimensions before scaling the preview.
    $('preview').style.transform='none';T.render($('preview'),state.template,currentFields(),options());
    const adjusted=T.fit($('preview'));
    const overflow=$('preview').querySelector('[data-overflow="true"]');
    $('fit-warning').hidden=(!adjusted.length && !overflow) || placeholderMode;
    $('fit-warning').textContent=overflow?'文字过长，无法完整显示。请减少文字或增加换行后再导出。':adjusted.length?`${[...new Set(adjusted.map(k=>labels[k]))].join('、')}已缩小适配；减少文字可让排版更舒展。`:'';
    $('template-name').textContent=T.names[state.template];$('preview-mode').textContent=placeholderMode?'占位符预览 · 导出将使用占位符':`文学日历 · 0${state.template+1} / 05`;
    $('placeholder-toggle').textContent=placeholderMode?'返回填写内容':'查看占位符';$('placeholder-toggle').setAttribute('aria-pressed',String(placeholderMode));
    $('texture-value').textContent=`${state.texture}%`;
    document.querySelectorAll('.template-button').forEach(btn=>btn.setAttribute('aria-pressed',String(Number(btn.dataset.template)===state.template)));
    resize();
  }
  for(const key of Object.keys(labels))$(key).addEventListener('input',()=>{state.fields[key]=$(key).value;placeholderMode=false;render();save();});
  $('date').addEventListener('change',()=>{if(!$('date').value)return;try{Object.assign(state.fields,T.dateFields($('date').value));state.date=$('date').value;placeholderMode=false;syncInputs();render();save();}catch(error){toast(error.message);}});
  $('texture').addEventListener('input',()=>{state.texture=Number($('texture').value);render();save();});
  $('export-scale').addEventListener('change',()=>{state.scale=Number($('export-scale').value);save();});
  $('placeholder-toggle').addEventListener('click',()=>{placeholderMode=!placeholderMode;render();});
  $('zoom-toggle').addEventListener('click',()=>{zoomed=!zoomed;$('preview-scroll').classList.toggle('zoomed',zoomed);$('zoom-toggle').textContent=zoomed?'适应画布':'放大查看';$('zoom-toggle').setAttribute('aria-pressed',String(zoomed));resize();});
  $('reset').addEventListener('click',()=>{state=initial();placeholderMode=false;syncInputs();render();save();toast('已恢复示例内容与样式');});
  $('save-config').addEventListener('click',()=>{download(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}),fileName('json'));toast('配置已下载，可随时载入继续编辑');});
  $('load-config').addEventListener('click',()=>$('config-file').click());
  $('config-file').addEventListener('change',async()=>{try{const file=$('config-file').files[0];if(!file)return;if(file.size>100000)throw new Error('配置文件过大，请选择纸日导出的 JSON');state=validate(JSON.parse(await file.text()));placeholderMode=false;syncInputs();render();save();toast('配置已载入');}catch(error){toast(error instanceof SyntaxError?'无法读取 JSON，请检查配置文件':error.message);}finally{$('config-file').value='';}});
  $('export-html').addEventListener('click',()=>{download(new Blob([T.createHTML(state.template,currentFields(),options())],{type:'text/html;charset=utf-8'}),fileName('html'));toast('已下载含纸纹的独立 HTML');});
  $('export-png').addEventListener('click',async()=>{
    const button=$('export-png');button.disabled=true;button.querySelector('span').textContent='正在生成…';
    // Capture a consistent edition even if the user edits while rendering.
    const template=state.template,fields={...currentFields()},opts=structuredClone(options()),name=fileName('png');
    try{download(await T.createPNG(template,fields,opts),name);toast(`PNG 已导出 · ${T.WIDTH*opts.scale} × ${T.HEIGHT*opts.scale}`);}
    catch(error){console.error(error);toast(error.message.includes('文字过长')?error.message:'PNG 导出失败，请用 Chrome / Edge 打开，或先导出 HTML');}
    finally{button.disabled=false;button.querySelector('span').textContent='导出 PNG';}
  });
  new ResizeObserver(resize).observe($('preview-scroll'));
  new ResizeObserver(resize).observe($('template-grid'));
  syncInputs();render();document.fonts.ready.then(render);
})();
