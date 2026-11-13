import assert from 'node:assert/strict';
import {normalize,compareText} from '../dist/text-metrics.mjs';
assert.equal(normalize(' ＡＢＣ，繁體測試！ G6 HE '),'abc繁体测试g6he');
assert.equal(normalize('Straße Σς ẞ'),'strasseσσss');
assert.equal(normalize('乾坤與乾燥，乾乾淨淨；瞭望與一目瞭然'),'乾坤与干燥干干净净瞭望与一目了然');
assert.notEqual(normalize('十五'),normalize('15'));
let result=compareText('今天下午开会','今天上午开会啊',[]);
assert.deepEqual([result.substitutions,result.deletions,result.insertions],[1,0,1]);assert.equal(result.cer,2/6);
result=compareText('好','很好很好很好',[]);assert.ok(result.cer>1);assert.equal(result.content_score,0);
result=compareText('十五和十五','五十和十五',['十五','不存在']);
assert.equal(result.keywords[0].occurrences,2);assert.equal(result.keywords[0].correct,1);assert.equal(result.keyword_accuracy,.5);assert.equal(result.keywords[1].excluded,true);
assert.equal(compareText('不可以','不太可以',['不可以']).keyword_accuracy,0);
assert.equal(compareText('人人人人','人人人人',['人人']).keywords[0].occurrences,2,'non-overlapping occurrences');
result=compareText('𠮷野家','𠮷野家',['𠮷野']);assert.equal(result.reference_characters,3);assert.equal(result.keyword_accuracy,1);
for(const reference of ['',null,'  \n']){result=compareText(reference,'独立识别的内容',['内容']);assert.equal(result.available,false);assert.equal(result.cer,null);assert.equal(result.content_score,null);assert.equal(result.keyword_accuracy,null);assert.equal(result.normalized_reference,null);assert.equal(result.normalized_hypothesis,'独立识别的内容');}
assert.throws(()=>compareText('。！','内容',[]),/没有可评分/);
assert.throws(()=>compareText('字'.repeat(5001),'字',[]),/5,000/);
assert.throws(()=>compareText('字','字'.repeat(5001),[]),/5,000/);
// Cross-check exact minimum distance against an independent full-matrix oracle.
function distance(a,b){const d=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));for(let i=0;i<=a.length;i++)d[i][0]=i;for(let j=0;j<=b.length;j++)d[0][j]=j;for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return d[a.length][b.length];}
for(const a of ['甲','甲乙','甲乙甲','不可以','十五和十五'])for(const b of ['','乙','甲乙乙','不太可以','五十和十五']){const r=compareText(a,b,[]);assert.equal(r.substitutions+r.deletions+r.insertions,distance(a,b));assert.equal(r.alignment.map(op=>op.reference).join(''),a);assert.equal(r.alignment.map(op=>op.recognized).join(''),b);}
JSON.stringify(result);
console.log('PASS text metrics: OpenCC phrase/character normalization, Unicode casefold/codepoints, exact CER, empty-reference nulls, positional keywords, limits, 25 independent distance cases.');
