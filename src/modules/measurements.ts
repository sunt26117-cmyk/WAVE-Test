import { ChannelMeasurements, MeasurementGate, WaveformChannel, CursorsState } from '../types/models';

function interpolateCrossingTime(t0:number,v0:number,t1:number,v1:number,level:number):number|null {
  const dv=v1-v0, dt=t1-t0;
  if(!Number.isFinite(dv)||!Number.isFinite(dt)||dt<=0||Math.abs(dv)<1e-15)return null;
  const frac=(level-v0)/dv;
  if(frac<-1e-9||frac>1+1e-9)return null;
  return t0+Math.max(0,Math.min(1,frac))*dt;
}

/**
 * Crossing time used by the period/duty state machine.
 *
 * That state machine trips one sample after the mid level was crossed (it waits
 * for the hysteresis band), so the interval which trips the trigger frequently
 * no longer brackets the mid level at all -- e.g. a 100 Hz sine sampled at
 * 10 kHz crosses it between the two preceding samples. The per-cycle offset is
 * identical, so extrapolating the crossing keeps period and duty exact, whereas
 * rejecting those intervals drops every edge and reports "Insufficient cycles".
 * The 10%/90% edge search keeps the strict, bracketed version above, because
 * there the level is bracketed by construction.
 */
function crossingTimeForPeriod(t0:number,v0:number,t1:number,v1:number,level:number):number|null {
  const dv=v1-v0, dt=t1-t0;
  if(!Number.isFinite(dv)||!Number.isFinite(dt)||dt<=0||Math.abs(dv)<1e-15)return null;
  return t0+((level-v0)/dv)*dt;
}

function estimateRobustEdgeLevels(values:Float32Array,startIdx:number,endIdx:number,minValue:number,maxValue:number):{low:number;high:number} {
  const count=endIdx-startIdx+1;
  if(count<8)return {low:minValue,high:maxValue};
  const sampleCount=Math.min(2048,count), samples=new Array<number>(sampleCount);
  for(let k=0;k<sampleCount;k++) {
    const ratio=sampleCount===1?0:k/(sampleCount-1);
    const index=Math.min(endIdx,startIdx+Math.round(ratio*(count-1)));
    samples[k]=values[index];
  }
  samples.sort((a,b)=>a-b);
  const percentile=(p:number):number=>{
    const position=(samples.length-1)*p, lower=Math.floor(position), upper=Math.ceil(position);
    if(lower===upper)return samples[lower];
    const weight=position-lower;
    return samples[lower]+(samples[upper]-samples[lower])*weight;
  };
  const low=percentile(0.05), high=percentile(0.95), robustSpan=high-low, rawSpan=maxValue-minValue;
  if(!Number.isFinite(low)||!Number.isFinite(high)||robustSpan<=Math.max(1e-12,rawSpan*1e-6))return {low:minValue,high:maxValue};
  return {low,high};
}

function collectThresholdCrossings(t:Float64Array,v:Float32Array,startIdx:number,endIdx:number,level:number,direction:'rising'|'falling'):number[] {
  const crossings:number[]=[];
  for(let i=startIdx+1;i<=endIdx;i++) {
    const v0=v[i-1],v1=v[i];
    if(!Number.isFinite(v0)||!Number.isFinite(v1))continue;
    const crossed=direction==='rising'
      ? ((v0<level&&v1>=level)||(v0<=level&&v1>level))
      : ((v0>level&&v1<=level)||(v0>=level&&v1<level));
    if(!crossed)continue;
    const crossingTime=interpolateCrossingTime(t[i-1],v0,t[i],v1,level);
    if(crossingTime!==null)crossings.push(crossingTime);
  }
  return crossings;
}

function pairTransitionDurations(startTimes:number[],endTimes:number[]):number[] {
  const durations:number[]=[], endCursorRef={value:0};
  for(const startTime of startTimes) {
    while(endCursorRef.value<endTimes.length&&endTimes[endCursorRef.value]<=startTime)endCursorRef.value++;
    if(endCursorRef.value>=endTimes.length)break;
    const duration=endTimes[endCursorRef.value]-startTime;
    if(Number.isFinite(duration)&&duration>0)durations.push(duration);
    endCursorRef.value++;
  }
  return durations;
}

function average(values:number[]):number|null { return values.length?values.reduce((a,b)=>a+b,0)/values.length:null; }

export function computeMeasurements(channel:WaveformChannel,gate:MeasurementGate,viewIndices:{startIndex:number;endIndex:number},cursors:CursorsState):ChannelMeasurements {
  const t=channel.t,v=channel.v,totalN=v.length;
  let startIdx=0,endIdx=totalN-1;
  if(gate==='view') {
    startIdx=Math.max(0,Math.min(totalN-1,viewIndices.startIndex));
    endIdx=Math.max(startIdx,Math.min(totalN-1,viewIndices.endIndex));
  } else if(gate==='cursors'&&cursors.enabled&&cursors.x1!==null&&cursors.x2!==null) {
    const xMin=Math.min(cursors.x1,cursors.x2),xMax=Math.max(cursors.x1,cursors.x2);
    let s=0;while(s<totalN&&t[s]<xMin)s++;
    let e=s;while(e<totalN&&t[e]<=xMax)e++;
    startIdx=Math.max(0,Math.min(totalN-1,s));endIdx=Math.max(startIdx,Math.min(totalN-1,e-1));
  }
  const sampleCount=endIdx-startIdx+1,timeStart=totalN>0?t[startIdx]:0,timeEnd=totalN>0?t[endIdx]:0;
  if(sampleCount<2)return {channelId:channel.id,channelName:channel.name,unit:channel.unit,gate,sampleCount,timeStart,timeEnd,max:sampleCount===1?v[startIdx]:null,min:sampleCount===1?v[startIdx]:null,average:sampleCount===1?v[startIdx]:null,rms:sampleCount===1?Math.abs(v[startIdx]):null,vpp:0,peak:sampleCount===1?Math.abs(v[startIdx]):null,period:null,frequency:null,dutyCycle:null,riseTime:null,fallTime:null,overshoot:null,undershoot:null,statusMessage:'Insufficient points in selected gate range.'};

  let min=Infinity,max=-Infinity,sum=0,sumSq=0,validCount=0;
  for(let i=startIdx;i<=endIdx;i++){const val=v[i];if(!Number.isFinite(val))continue;if(val<min)min=val;if(val>max)max=val;sum+=val;sumSq+=val*val;validCount++;}
  if(validCount===0||!Number.isFinite(min)||!Number.isFinite(max))return {channelId:channel.id,channelName:channel.name,unit:channel.unit,gate,sampleCount:0,timeStart,timeEnd,max:null,min:null,average:null,rms:null,vpp:null,peak:null,period:null,frequency:null,dutyCycle:null,riseTime:null,fallTime:null,overshoot:null,undershoot:null,statusMessage:'No valid numeric samples in range.'};

  const averageValue=sum/validCount,rms=Math.sqrt(sumSq/validCount),vpp=max-min,peak=Math.max(Math.abs(max),Math.abs(min));
  let period:number|null=null,frequency:number|null=null,dutyCycle:number|null=null,riseTime:number|null=null,fallTime:number|null=null,overshoot:number|null=null,undershoot:number|null=null;
  let statusMessage:string|undefined;

  if(vpp>1e-9){
    const midLevel=(max+min)/2,hysteresis=.05*vpp,midHigh=midLevel+hysteresis,midLow=midLevel-hysteresis;
    const risingEdgeTimes:number[]=[],fallingEdgeTimes:number[]=[];
    let state:'low'|'high'=v[startIdx]>=midLevel?'high':'low';
    for(let i=startIdx+1;i<=endIdx;i++){
      const vPrev=v[i-1],vCurr=v[i];if(!Number.isFinite(vPrev)||!Number.isFinite(vCurr))continue;
      if(state==='low'&&vCurr>=midHigh){const ct=crossingTimeForPeriod(t[i-1],vPrev,t[i],vCurr,midLevel);if(ct!==null)risingEdgeTimes.push(ct);state='high';}
      else if(state==='high'&&vCurr<=midLow){const ct=crossingTimeForPeriod(t[i-1],vPrev,t[i],vCurr,midLevel);if(ct!==null)fallingEdgeTimes.push(ct);state='low';}
    }
    if(risingEdgeTimes.length>=2){let totalPeriod=0;const count=risingEdgeTimes.length-1;for(let k=0;k<count;k++)totalPeriod+=risingEdgeTimes[k+1]-risingEdgeTimes[k];period=totalPeriod/count;if(period>0)frequency=1/period;if(fallingEdgeTimes.length){const r1=risingEdgeTimes[0],r2=risingEdgeTimes[1],f=fallingEdgeTimes.find(x=>x>r1&&x<r2);if(f)dutyCycle=((f-r1)/(r2-r1))*100;}}
    else statusMessage='Insufficient cycles in range for period/frequency detection';

    // FIX: 10% and 90% crossings are detected independently. A rise/fall may span many samples.
    const levels=estimateRobustEdgeLevels(v,startIdx,endIdx,min,max),span=levels.high-levels.low;
    if(span>1e-12){
      const v10=levels.low+.1*span,v90=levels.low+.9*span;
      const rise10=collectThresholdCrossings(t,v,startIdx,endIdx,v10,'rising');
      const rise90=collectThresholdCrossings(t,v,startIdx,endIdx,v90,'rising');
      const fall90=collectThresholdCrossings(t,v,startIdx,endIdx,v90,'falling');
      const fall10=collectThresholdCrossings(t,v,startIdx,endIdx,v10,'falling');
      riseTime=average(pairTransitionDurations(rise10,rise90));
      fallTime=average(pairTransitionDurations(fall90,fall10));
      if(riseTime===null&&fallTime===null)statusMessage=statusMessage?`${statusMessage}; no complete 10%-90% edge found`:'No complete 10%-90% edge found in selected range';
    }
    if(dutyCycle!==null){const nominalStep=vpp;if(nominalStep>0){overshoot=Math.max(0,((max-(midLevel+.4*vpp))/nominalStep)*100);undershoot=Math.max(0,(((midLevel-.4*vpp)-min)/nominalStep)*100);}}
  }
  return {channelId:channel.id,channelName:channel.name,unit:channel.unit,gate,sampleCount,timeStart,timeEnd,max,min,average:averageValue,rms,vpp,peak,period,frequency,dutyCycle,riseTime,fallTime,overshoot,undershoot,statusMessage};
}
