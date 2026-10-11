/** Main-Deck-only hypergeometric probabilities. Pure, original reference code.
 * Valid counts include incomplete editing decks; consumers must label their scope.
 */
function check(N, K, n) {
  if (![N,K,n].every(Number.isInteger) || N < 0 || N > 512 || K < 0 || K > N || n < 0 || n > N)
    throw new RangeError('Expected integer counts: 0 <= K,n <= N <= 512.');
}
export function atLeastOne(N, K, n) {
  check(N,K,n);
  if (!K || !n) return 0;
  if (N-K<n) return 1;
  let none = 1;
  for (let i=0; i<n; i++) none *= (N-K-i)/(N-i);
  return Math.max(0,Math.min(1,1-none));
}
function logChoose(N,r) {
  if(r<0||r>N) return -Infinity;
  r=Math.min(r,N-r);let value=0;
  for(let i=1;i<=r;i++) value+=Math.log(N-r+i)-Math.log(i);
  return value;
}
export function atLeast(N,K,n,r=1) {
  check(N,K,n);
  if(!Number.isInteger(r)||r<0) throw new RangeError('Minimum copies must be a non-negative integer.');
  if(r===0) return 1;
  if(r>Math.min(K,n)) return 0;
  let result=0;
  for(let x=Math.max(r,n-(N-K));x<=Math.min(K,n);x++)
    result+=Math.exp(logChoose(K,x)+logChoose(N-K,n-x)-logChoose(N,n));
  return Math.max(0,Math.min(1,result));
}
/** Exact probability of seeing >=1 from A AND >=1 from B, allowing overlap. */
export function atLeastOneFromBoth(N, a, b, overlap, n) {
  check(N,a,n);check(N,b,n);
  if(!Number.isInteger(overlap)||overlap<0||overlap>Math.min(a,b)||a+b-overlap>N)
    throw new RangeError('Invalid group overlap.');
  const none=k=>1-atLeastOne(N,k,n);
  return Math.max(0,Math.min(1,1-none(a)-none(b)+none(a+b-overlap)));
}
