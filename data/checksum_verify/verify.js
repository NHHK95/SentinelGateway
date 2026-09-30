const NHI_LETTER_VALUES = {A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:9,K:10,L:11,M:12,N:13,P:14,Q:15,R:16,S:17,T:18,U:19,V:20,W:21,X:22,Y:23,Z:24};
const W = [7,6,5,4,3,2];
function val(t,i){const c=t[i].toUpperCase(); return /[0-9]/.test(c)?Number(c):NHI_LETTER_VALUES[c];}
function isValidLegacyNhi(token) {
  if (!/^[A-HJ-NP-Z]{3}[0-9]{4}$/i.test(token)) return false;
  let sum=0; for(let i=0;i<6;i++){const v=val(token,i); if(v===null) return false; sum+=v*W[i];}
  const r=sum%11; const exp=r===0?0:11-r; if(exp===10) return false;
  return Number(token[6])===exp;
}

console.log('=== Cross-verification: Python-generated tokens against engine.js logic ===\n');
console.log('Expected VALID (constructed with correct checksum):');
['LEN0187','DMU0836','BCP6138','CTP0913','HWW9090'].forEach(t=>console.log(' ',t,'->',isValidLegacyNhi(t)));
console.log('\nExpected INVALID (deliberately wrong checksum digit):');
['LEN0181','MUB8301','PPC3187','BUD3907','BHB8247'].forEach(t=>console.log(' ',t,'->',isValidLegacyNhi(t)));
