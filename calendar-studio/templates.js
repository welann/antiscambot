/* Calendar templates: HTML text + CSS layout + SVG decoration. No network required. */
(() => {
  'use strict';
  const WIDTH = 1122, HEIGHT = 1402;
  const names = ['留白日历', '几何拼贴', '文学书页', '构成主义', '古典报刊'];
  const placeholders = { month: '[MONTH]', day: '[DAY]', weekday: '[WEEKDAY]', fullDate: '[FULL DATE]', weekNo: '[WEEK NO]', dayOfYear: '[DAY OF YEAR]', year: '[YEAR]', quote: '[QUOTE LINE 1]\n[QUOTE LINE 2]\n[QUOTE LINE 3]', bookTitle: '[BOOK TITLE]', author: '[AUTHOR]', footer: '[FOOTER]', issue: '[NO.]' };
  const defaults = { month: 'SEPTEMBER', day: '13', weekday: '星期日', fullDate: '2026 年 9 月 13 日', weekNo: '37', dayOfYear: '256 / 365', year: '2026', quote: '风吹过城市的边缘，时间像纸页一样轻轻翻动。\n我们在写下句子的同时，也在慢慢辨认自己。', bookTitle: '《今日摘句》', author: '匿名', footer: 'Read the day. Write the self.', issue: '03' };
  const decorativeDefaults = {
    0: { left: 'DAILY\nLITERARY\nCALENDAR', right: 'DAY' },
    1: { topLeft: 'LITERATURE\nNOTE', left: 'A\nBETTER\nYOU\nA\nBRIGHTER\nTOMORROW', topRight: 'DESK\nCALENDAR', right: 'READ\nTHINK\nWRITE\nLIVE', middle: 'SAME\nPAGES\nA\nBRIGHTER\nYOU', bottomLeft: 'SMALL\nWORDS\nBIG\nCHANGES', bottom: 'LITERATURE KEEPS US HUMAN' },
    2: { left: 'A\nBRIGHTER\nMIND\nA CALMER\nDAY', right: 'BOOKS\nIDEAS\nPEOPLE\nA KINDER\nWORLD', bottomLeft: 'READ\nTHINK\nREFLECT\nGROW', bottomRight: 'SMALL\nWORDS\nBIG\nCHANGE', bottom: 'LITERATURE FOR A MORE HUMAN TOMORROW' },
    3: { topLeft: 'A\nPAGE\nA\nBRIGHTER\nDAY', topCenter: 'LITERATURE\nFOR A MORE\nTHOUGHTFUL\nTOMORROW', topRight: 'BOOKS\nIDEAS\nPEOPLE\nA KINDER\nWORLD', middle: 'SMALL\nREADING\nBIGGER\nPERSPECTIVE', bottomRight: 'GOOD\nBOOKS\nBRIGHTER\nDAYS' },
    4: { topLeft: 'LITERATURE\nBUILDS\nA BRIGHTER\nWORLD', topRight: 'READ\nREFLECT\nBE KIND\nREPEAT', left: 'SMALL\nPAGES\nBIG\nPROGRESS', right: 'MORE\nGOOD\nIDEAS\nTODAY', center: 'A NEW DAY　A BRIGHTER MIND', quoteHeader: 'TODAY’S QUOTE', quoteTagline: 'WORDS FOR A BETTER TOMORROW', spineLeft: 'LITERATURE', spineRight: 'A CALMER STRONGER YOU', bottomLeft: 'DAILY\nLITERARY\nCALENDAR', bottomRight: 'IDEAS\nPEOPLE\nBOOKS\nA KINDER YOU' }
  };
  const css = `
    .calendar{position:relative;width:1122px;height:1402px;overflow:hidden;color:#151513;background:#faf9f5;font-family:"Times New Roman","Songti SC","Noto Serif CJK SC",serif;isolation:isolate;-webkit-font-smoothing:antialiased}
    .calendar,.calendar *{box-sizing:border-box}
    .calendar .paper{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;z-index:0}
    .calendar .deco{position:absolute;inset:0;width:100%;height:100%;z-index:1;overflow:hidden}
    .calendar .text{position:absolute;z-index:2;display:flex;align-items:center;justify-content:center;text-align:center;white-space:pre-wrap;overflow:hidden;line-height:1.2;overflow-wrap:anywhere;min-width:0}
    .calendar .text span{white-space:pre;flex-shrink:0;max-width:none}
    .calendar .text.left{justify-content:flex-start;text-align:left}.calendar .text.right{justify-content:flex-end;text-align:right}
    .calendar .micro{font-family:"Arial Narrow",Arial,"PingFang SC",sans-serif;letter-spacing:5px;line-height:1.65}
    .calendar .serifmicro{letter-spacing:5px;line-height:1.5}
    .calendar .display{font-family:"Times New Roman",Didot,"Songti SC",serif;line-height:1;white-space:nowrap;overflow-wrap:normal}
    .calendar .heavy{font-family:Impact,"Arial Narrow","PingFang SC",sans-serif;font-weight:900;line-height:1.06;white-space:nowrap;overflow-wrap:normal}
    .calendar .quote{line-height:1.35}.calendar .white{color:#f5f3e9}.calendar .italic{font-style:italic;letter-spacing:8px}
    .calendar .inkgrain{position:absolute;inset:0;width:100%;height:100%;z-index:3;pointer-events:none;opacity:.12;mix-blend-mode:screen}
  `;
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const line = (x1,y1,x2,y2,w=1.5,color='#22221e') => `<path d="M${x1} ${y1}L${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${w}"/>`;
  const rect = (x,y,w,h,fill='none',stroke='#22221e',sw=1.5) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
  const poly = (points, fill='#20201d') => `<polygon points="${points}" fill="${fill}"/>`;

  function markup(template=0, fields={}, options={}) {
    template = Math.max(0, Math.min(4, Number(template) || 0));
    const f = Object.fromEntries(Object.keys(placeholders).map(k=>[k, fields[k] == null || fields[k] === '' ? placeholders[k] : String(fields[k])]));
    if(!fields.quote) f.quote=Array.from({length:[2,2,3,4,3][template]},(_,i)=>`[QUOTE LINE ${i+1}]`).join('\n');
    const d = {...decorativeDefaults[template], ...(options.decorative || {})};
    const texture = Math.max(0, Math.min(1, Number(options.texture ?? .25)));
    let texts = '', svg = '';
    const text = (value,x,y,w,h,size,cls='',style='',field='') => { texts += `<div class="text ${cls}" data-size="${size}" ${field ? `data-field="${field}"` : ''} style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;font-size:${size}px;${style}"><span>${esc(value)}</span></div>`; };
    const field = (k,x,y,w,h,size,cls='',style='') => text(f[k],x,y,w,h,size,cls,style,k);
    const copy = (k,x,y,w,h,size=14,cls='micro left',style='') => text(d[k] ?? '',x,y,w,h,size,cls,style);
    const quote = (x,y,w,h,size,thirdSize) => {
      const lines=f.quote.split('\n');
      if(template===3 && lines.length<=4) {
        lines.forEach((value,i)=>text(value,x,y+i*h/4,w,h/4,size,'left',`color:${['#151513','#151513','#66665e','#828278'][i]}`,'quote'));
      } else if (thirdSize && lines.length===3) {
        text(lines.slice(0,2).join('\n'),x,y,w,h*.7,size,'quote','','quote');
        text(lines[2],x,y+h*.7,w,h*.3,thirdSize,'quote','','quote');
      } else field('quote',x,y,w,h,size,'quote',template===0?'line-height:1.65':'');
    };
    if(template===0) {
      svg += line(77,97,77,566,1)+line(1044,97,1044,566,1)+line(77,711,77,1232,1)+line(1044,711,1044,1232,1)+line(62,690,92,690,1)+line(1031,682,1060,682,1)+line(547,1226,575,1226,1)+line(77,1288,1045,1288,1);
      field('weekday',300,80,522,55,39,'','letter-spacing:16px');
      field('fullDate',280,145,562,37,25,'','letter-spacing:5px');
      text(f.weekNo.startsWith('[') ? f.weekNo : `第 ${f.weekNo} 周  /  WEEK ${f.weekNo}`,280,185,562,38,25,'','letter-spacing:4px','weekNo');
      text(`(${f.month})`,140,250,842,140,104,'display','letter-spacing:10px','month');
      field('day',250,408,622,462,600,'display','line-height:.75');
      copy('left',61,595,160,81,18,'serifmicro left');
      copy('right',957,605,105,30,18,'serifmicro right');
      field('dayOfYear',936,637,126,25,19,'right','letter-spacing:2px');
      quote(126,922,870,148,41);
      field('bookTitle',260,1115,602,40,25,'','letter-spacing:3px');
      field('author',260,1161,602,40,24,'','letter-spacing:6px');
      field('footer',153,1301,816,47,23,'italic');
    }
    if(template===1) {
      svg += `<defs><linearGradient id="circleShade" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#141412"/><stop offset="1" stop-color="#93938e"/></linearGradient></defs><path d="M744 -123 A280 245 0 0 0 744 367Z" fill="#e0dfda"/><path d="M744 -44 C985 50 985 311 744 420Z" fill="url(#circleShade)"/>`;
      svg += line(226,33,226,343,2)+line(949,0,949,579,2)+line(176,554,176,837,1.5)+line(54,837,1068,837,2)+rect(56,859,1010,348,'#deddd6','none');
      svg += `<ellipse cx="-35" cy="1286" rx="280" ry="295" fill="url(#circleShade)"/>`+line(55,1000,55,1402,1,'#faf9f5');
      svg += poly('786,1362 1066,1083 1066,1362','#bebdb6')+poly('949,1200 1066,1083 1066,1362 949,1362')+line(759,1367,1115,1007,2);
      svg += line(58,149,83,149,2)+line(970,149,995,149,2)+line(58,649,91,649,2)+line(967,654,993,654,2)+line(526,1066,598,1066,2)+line(f.footer.length>16?220:323,1308,f.footer.length>16?340:466,1308,1)+line(f.footer.length>16?783:658,1307,f.footer.length>16?903:799,1307,1)+line(80,1330,105,1330,1,'#f7f6ee');
      copy('topLeft',58,68,153,47,17,'serifmicro left');copy('left',59,170,150,118);copy('topRight',970,68,137,41);field('year',970,111,117,20,14,'micro left');copy('right',970,178,135,83);
      field('month',53,365,851,167,174,'display','letter-spacing:-5px;line-height:.85');field('day',205,526,710,285,380,'display','line-height:.75');
      text('TODAY',58,605,110,32,18,'serifmicro left');copy('middle',59,680,112,99);
      field('weekday',966,600,144,35,23,'left');field('fullDate',966,679,143,32,18,'left');field('weekNo',966,714,143,28,18,'left');field('dayOfYear',966,743,143,28,18,'left');
      quote(99,887,924,135,52);field('bookTitle',290,1097,543,38,23,'','letter-spacing:4px');field('author',290,1138,543,30,22,'','letter-spacing:4px');
      copy('bottomLeft',80,1230,130,84,13,'micro white left');field('footer',f.footer.length>16?350:471,1283,f.footer.length>16?423:183,42,20,'','letter-spacing:4px');copy('bottom',352,1321,425,24,11,'micro');
    }
    if(template===2) {
      svg += rect(41,44,1040,1314)+line(41,146,1081,146)+line(293,44,293,146)+line(767,44,767,146)+line(227,170,227,467)+line(895,170,895,467)+line(54,491,1068,491,2);
      svg += poly('54,503 121,503 54,570','#292923')+poly('1001,503 1068,503 1068,578 1051,578 1051,552 1034,552 1034,527 1001,527','#292923');
      svg += line(108,535,1001,535,1)+line(56,581,56,1194)+line(1066,584,1066,1194)+line(56,1194,1066,1194)+rect(56,1174,16,20,'#292923','none')+rect(1050,1174,16,20,'#292923','none');
      svg += line(519,955,606,955,2)+rect(56,1216,123,126,'#292923','none')+rect(943,1216,123,126,'#292923','none')+line(207,1248,916,1248,2)+line(85,1327,109,1327,1,'#f8f6ed')+line(974,1327,998,1327,1,'#f8f6ed');
      field('weekday',65,71,204,50,27,'micro','font-weight:600');field('fullDate',325,77,410,47,22,'micro');text(`${f.weekNo} / ${f.dayOfYear}`,786,79,280,40,17,'micro','','weekNo');
      field('month',267,179,588,75,62,'display','letter-spacing:12px');field('day',287,251,548,203,260,'display','line-height:.75');
      copy('left',80,250,126,158,15);copy('right',935,250,128,158,15);svg+=line(80,429,113,429,2)+line(936,429,969,429,2);
      quote(109,601,904,306,79,49);field('bookTitle',142,988,838,70,41,'','letter-spacing:8px');field('author',219,1067,684,44,23,'micro');
      copy('bottomLeft',85,1227,88,88,12,'micro left white');copy('bottomRight',974,1227,82,88,12,'micro left white');
      field('footer',210,1264,705,40,17,'micro');copy('bottom',306,1311,511,29,9,'micro');
    }
    if(template===3) {
      svg += line(634,26,634,171,2)+line(662,47,732,47,2)+line(42,155,65,155,2)+poly('797,19 1099,19 1099,348')+line(1059,162,1081,162,1,'#eeeae0');
      svg += rect(42,185,593,162,'#20201d','none')+line(661,189,661,773,2);
      [278,373,468,562].forEach(y=>svg+=line(691,y,888,y,2));svg+=line(691,752,719,752,2);
      svg += `<defs><linearGradient id="concrete"><stop stop-color="#aaa99f"/><stop offset="1" stop-color="#66675f"/></linearGradient><pattern id="panels" width="48" height="126" patternUnits="userSpaceOnUse" patternTransform="skewY(-24)"><rect width="48" height="126" fill="none" stroke="#33372e" stroke-opacity=".16"/><circle cx="10" cy="18" r="1.5" fill="#33372e" opacity=".25"/><circle cx="38" cy="108" r="1.5" fill="#33372e" opacity=".25"/></pattern></defs>`;
      svg += poly('918,180 1093,353 918,473','#cfcec4')+poly('918,473 1093,369 1093,1064 918,1064','url(#concrete)')+poly('918,473 1093,369 1093,1064 918,1064','url(#panels)')+poly('918,640 1093,793 1093,1064 918,1064');
      svg += rect(42,796,151,267,'#20201d','none')+rect(193,796,708,267)+rect(42,1078,151,150)+poly('42,1078 193,1228 42,1228')+line(214,1080,1093,1080,2)+line(241,1166,936,1166,1)+rect(39,1243,1056,121)+rect(883,1243,212,121,'#20201d','none')+line(982,1348,1005,1348,1,'#eeeae0');
      copy('topLeft',42,31,170,110,13);copy('topCenter',661,64,226,92,14);copy('topRight',967,31,118,115,13,'micro right white');
      field('month',74,205,530,122,115,'heavy white');field('day',33,379,610,388,436,'heavy','line-height:.87');
      field('weekday',691,199,202,58,37,'heavy left');field('fullDate',691,293,202,58,37,'heavy left');field('weekNo',691,388,202,58,37,'heavy left');field('dayOfYear',691,481,202,58,37,'heavy left');copy('middle',691,636,204,103,14);
      text('“',65,842,110,170,208,'white','font-family:Georgia,serif');quote(238,815,622,231,44);
      field('bookTitle',238,1090,704,70,50,'heavy left','letter-spacing:4px');field('author',238,1176,704,45,32,'micro left');field('footer',231,1271,573,64,20,'micro');copy('bottomRight',981,1258,99,83,12,'micro left white');
    }
    if(template===4) {
      svg += rect(34,34,1054,1334,'none','#1f211b',2)+rect(47,47,217,172)+rect(274,47,575,172)+rect(859,47,217,172)+line(274,151,849,151);
      svg += rect(47,237,1029,457)+line(246,237,246,694)+line(260,237,260,694)+line(863,237,863,694)+line(878,237,878,694)+line(47,289,246,289)+line(878,289,1076,289)+line(60,496,232,496)+line(891,496,1063,496)+line(260,518,863,518)+line(260,627,863,627)+line(285,662,344,662)+line(779,662,838,662);
      svg += line(34,711,1088,711)+rect(47,725,1029,513)+line(47,774,1076,774)+line(119,725,119,1238)+line(1003,725,1003,1238)+line(47,857,119,857)+line(331,751,697,751,1,'#86867d')+line(521,1069,601,1069);
      svg += line(34,1254,1088,1254)+rect(47,1269,1029,87)+line(193,1269,193,1356)+line(926,1269,926,1356)+line(220,1314,f.footer.length>16?305:444,1314)+line(f.footer.length>16?818:678,1314,902,1314);
      for(const y of [34,699,1242,1355]) for(const x of [34,1076]) svg+=rect(x,y,12,13,'#171912','none');
      svg += poly('63,748 69,742 76,748 69,755')+poly('1047,748 1053,742 1060,748 1053,755');
      copy('topLeft',69,78,173,100,16,'serifmicro');copy('topRight',881,78,172,100,16,'serifmicro');svg+=line(134,188,177,188)+line(948,188,990,188);
      field('weekday',296,62,531,76,54,'display','letter-spacing:6px');field('fullDate',296,164,531,44,22,'','letter-spacing:9px');
      text('WEEK NO.',62,246,170,35,17,'serifmicro');text('DAY OF YEAR',890,246,175,35,17,'serifmicro');field('weekNo',65,310,163,147,44,'','letter-spacing:4px');field('dayOfYear',894,310,166,147,38,'','letter-spacing:3px');
      field('day',287,264,550,232,294,'display','line-height:.76');field('month',288,532,548,80,59,'display','letter-spacing:6px');copy('left',88,550,145,103,15,'serifmicro left');copy('right',941,550,108,103,15,'serifmicro left');copy('center',367,643,388,41,15,'serifmicro');
      copy('quoteHeader',144,734,184,35,17,'serifmicro left');copy('quoteTagline',720,736,265,30,12,'serifmicro');text('No.',61,783,44,31,14);field('issue',61,812,44,30,22);
      text([...String(d.spineLeft)].join('\n'),63,890,35,330,14,'','line-height:2.35');text([...String(d.spineRight)].join('\n'),1024,793,34,432,12,'','line-height:1.8');
      quote(154,800,814,242,69,38);field('bookTitle',161,1093,800,63,34,'','letter-spacing:6px');field('author',190,1154,742,46,22,'','letter-spacing:5px');
      copy('bottomLeft',70,1283,119,62,13,'serifmicro left','letter-spacing:3px');copy('bottomRight',953,1280,117,68,11,'serifmicro left','letter-spacing:2px');field('footer',f.footer.length>16?322:462,1287,f.footer.length>16?478:199,51,21,'','letter-spacing:4px');
    }
    const grain = options.grain === false || template===0 ? '' : `<svg class="inkgrain" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1122 1402" aria-hidden="true"><filter id="inkNoise"><feTurbulence type="fractalNoise" baseFrequency=".62" numOctaves="3" seed="8" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="1122" height="1402" filter="url(#inkNoise)"/></svg>`;
    return `<article xmlns="http://www.w3.org/1999/xhtml" class="calendar" aria-label="${names[template]}" style="background:${template===4?'#f6f4e9':template===3?'#f3f1e8':'#faf9f5'}"><img class="paper" src="${window.CALENDAR_PAPER}" style="opacity:${texture}" alt=""/><svg class="deco" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" aria-hidden="true">${svg}</svg>${texts}${grain}</article>`;
  }

  function fit(root) {
    const adjusted=[];
    root.querySelectorAll('.text').forEach(el=>{
      const span=el.firstElementChild;
      let size=Number(el.dataset.size);
      el.style.fontSize=`${size}px`;
      // Keep authored lines and shrink the type to the bounded text area.
      // scrollWidth also catches a single unbroken English word.
      let count=0;
      while ((span.getBoundingClientRect().height > el.getBoundingClientRect().height+.5 || span.scrollWidth > el.clientWidth+1 || span.getBoundingClientRect().width > el.getBoundingClientRect().width+.5) && size>5 && count++<160) {
        size*=.96;el.style.fontSize=`${size}px`;
      }
      el.dataset.overflow=String(span.scrollWidth>el.clientWidth+1 || span.getBoundingClientRect().height>el.getBoundingClientRect().height+.5);
      if(el.dataset.field && size<Number(el.dataset.size)*.65) adjusted.push(el.dataset.field);
    });
    return [...new Set(adjusted)];
  }

  function render(container,template,fields,options) {
    container.innerHTML=markup(template,fields,options);
    fit(container);
    return container.firstElementChild;
  }

  function dateFields(iso) {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error('日期格式应为 YYYY-MM-DD');
    const date=new Date(`${iso}T12:00:00Z`);
    if(!Number.isFinite(+date) || date.toISOString().slice(0,10)!==iso) throw new Error('日期无效');
    const year=date.getUTCFullYear(), month=date.getUTCMonth(), day=date.getUTCDate();
    const utc=(y,m,d)=>{const value=new Date(0);value.setUTCFullYear(y,m,d);value.setUTCHours(0,0,0,0);return +value;};
    const start=utc(year,0,1), doy=Math.floor((+date-start)/86400000)+1;
    const total=(utc(year+1,0,1)-start)/86400000;
    const thursday=new Date(utc(year,month,day));
    thursday.setUTCDate(thursday.getUTCDate()+4-(thursday.getUTCDay()||7));
    const week=Math.ceil((((+thursday-utc(thursday.getUTCFullYear(),0,1))/86400000)+1)/7);
    return {year:String(year),month:['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'][month],day:String(day),weekday:['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][date.getUTCDay()],fullDate:`${year} 年 ${month+1} 月 ${day} 日`,weekNo:String(week),dayOfYear:`${doy} / ${total}`};
  }

  async function createPNG(template, fields, options={}) {
    const scale=Number(options.scale ?? 2);
    if(![1,2,3].includes(scale)) throw new Error('导出倍率需为 1、2 或 3');
    await document.fonts.ready;
    const stage=document.createElement('div');
    stage.style.cssText='position:fixed;left:-20000px;top:0;width:1122px;visibility:hidden;';
    document.body.append(stage);
    try {
      stage.innerHTML=`<style>${css}</style>${markup(template,fields,options)}`;
      await Promise.all([...stage.querySelectorAll('img')].map(img=>img.decode()));
      fit(stage);
      if(stage.querySelector('[data-overflow="true"]')) throw new Error('文字过长，请减少文字或增加换行后再导出');
      const node=stage.querySelector('.calendar');
      const body=new XMLSerializer().serializeToString(node);
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH*scale}" height="${HEIGHT*scale}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><foreignObject width="${WIDTH}" height="${HEIGHT}"><div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style>${body}</div></foreignObject></svg>`;
      const img=new Image();
      // A data URL keeps the self-contained foreignObject canvas origin-clean in Chromium.
      img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
      await img.decode();
      const canvas=document.createElement('canvas');canvas.width=WIDTH*scale;canvas.height=HEIGHT*scale;
      canvas.getContext('2d').drawImage(img,0,0);
      return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('图片生成失败，请重试')),'image/png'));
    } finally { stage.remove(); }
  }

  function createHTML(template,fields,options={}) {
    // Persist fitted sizes so the standalone document matches the editor.
    const stage=document.createElement('div');stage.style.cssText='position:fixed;left:-20000px;top:0';document.body.append(stage);
    stage.innerHTML=markup(template,fields,options);fit(stage);
    const body=stage.innerHTML;stage.remove();
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=1122"><title>${esc(names[template])}</title><style>body{margin:0}${css}@media print{@page{size:1122px 1402px;margin:0}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style><body>${body}</body></html>`;
  }

  const style=document.createElement('style');style.textContent=css;document.head.append(style);
  window.CalendarTemplates={WIDTH,HEIGHT,names,placeholders,defaults,decorativeDefaults,css,markup,fit,render,dateFields,createPNG,createHTML};
})();
