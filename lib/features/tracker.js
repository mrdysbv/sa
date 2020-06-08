const {screenToMarkerCoordinate, applyModelViewProjectionTransform, buildModelViewProjectionTransform, computeScreenCoordiate} = require('../icp/utils.js');

// const AR2_TRACKING_CANDIDATE_MAX = 200;  artoolkit overflow error. but better dont

const AR2_DEFAULT_SEARCH_FEATURE_NUM = 16;
const AR2_TEMP_SCALE = 2;
const AR2_DEFAULT_TS = 6;
const AR2_DEFAULT_TRACKING_SD_THRESH = 5.0;
const AR2_SIM_THRESH = 0.5;
const AR2_TRACKING_THRESH = 5.0;
const AR2_SEARCH_SIZE = 6;

const SKIP_INTERVAL = 3;

const createTracker = ({imageList, dpiList, targetImage, featureSets, projectionTransform, debugContent}) => {
  const tracker = {
    dpiList: dpiList,
    imageList: imageList,
    projectionTransform: projectionTransform,
    featureSets: featureSets,

    track: ({modelViewTransform}) => {

      const modelViewProjectionTransform = buildModelViewProjectionTransform(tracker.projectionTransform, modelViewTransform);
      console.log("modelViewProjectionTransform", modelViewProjectionTransform);

      const candidates1 = [];
      const candidates2 = [];
      let debugFeatureIndex = 0;
      for (let j = 0; j < featureSets.length; j++) {
        const maxdpi = featureSets[j].maxdpi;
        const mindpi = featureSets[j].mindpi;
        for (let k = 0; k < featureSets[j].coords.length; k++) {
          const {mx, my} = featureSets[j].coords[k];
          const u = computeScreenCoordiate(modelViewProjectionTransform, mx, my, 0);
          if (u === null) continue;
          const {x: sx, y: sy} = u;

          const vdir = [];
          vdir[0] = modelViewTransform[0][0] * mx
                  + modelViewTransform[0][1] * my
                  + modelViewTransform[0][3];
          vdir[1] = modelViewTransform[1][0] * mx
                  + modelViewTransform[1][1] * my
                  + modelViewTransform[1][3];
          vdir[2] = modelViewTransform[2][0] * mx
                  + modelViewTransform[2][1] * my
                  + modelViewTransform[2][3];
          const vlen = Math.sqrt(vdir[0]*vdir[0] + vdir[1]*vdir[1] + vdir[2]*vdir[2]);
          vdir[0] /= vlen;
          vdir[1] /= vlen;
          vdir[2] /= vlen;
          const vdirValue = vdir[0]*modelViewTransform[0][2] + vdir[1]*modelViewTransform[1][2] + vdir[2]*modelViewProjectionTransform[2][2];

          //console.log("compare: ", {j, k, sx, sy, mx, my, maxdpi, mindpi, vdir, vdirValue}, debugContent.trackFeatures[debugFeatureIndex++]);
          if (vdirValue > -0.1) continue;

          if (sx < 0 || sx >= targetImage.width) continue;
          if (sy < 0 || sy >= targetImage.height) continue;

          const u1 = computeScreenCoordiate(modelViewProjectionTransform, mx+10, my, 0);
          const u2 = computeScreenCoordiate(modelViewProjectionTransform, mx, my+10, 0);
          const d1 = (u1.x - u.x) * (u1.x - u.x) + (u1.y - u.y) * (u1.y - u.y);
          const d2 = (u2.x - u.x) * (u2.x - u.x) + (u2.y - u.y) * (u2.y - u.y);
          const dpi = [];
          if (d1 < d2) {
            dpi[0] = Math.sqrt(d2) * 2.54;
            dpi[1] = Math.sqrt(d1) * 2.54;
          } else {
            dpi[0] = Math.sqrt(d1) * 2.54;
            dpi[1] = Math.sqrt(d2) * 2.54;
          }
          //console.log("dpi", dpi);

          let candidates = null;
          if (dpi[1] <= maxdpi && dpi[1] >= mindpi) {
            candidates = candidates1;
          } else if(dpi[1] <= maxdpi * 2 && dpi[1] >= mindpi / 2) {
            candidates = candidates2;
          }
          if (candidates !== null) {
            candidates.push({level: j, num: k, sx: sx, sy: sy, mx, my, flag: false})
          }
        }
      }

      console.log("candidates1: ", candidates1.length, debugContent.candidates1.length);
      for (let i = 0; i < candidates1.length; i++) {
        //console.log("compare", candidates1[i], 'vs', debugContent.candidates1[i]);
      }
      console.log("candidates2: ", candidates2.length, debugContent.candidates2.length);
      for (let i = 0; i < candidates2.length; i++) {
        //console.log("compare", candidates2[i], 'vs', debugContent.candidates2[i]);
      }

      let i = 0;
      let num = 0;
      let pos = [null, null, null, null];
      let candidates = candidates1;
      let fromCandidates1 = true;
      let prevFeatures = [];
      while (i < AR2_DEFAULT_SEARCH_FEATURE_NUM) {
        let k = _selectTemplate({pos, prevFeatures, candidates, num, xsize: targetImage.width, ysize: targetImage.height});
        if (k < 0 && fromCandidates1) {
          fromCandidates1 = false;
          candidates = candidates2;
          continue;
        }

        if (k < 0) break;

        candidates[k].flag = true;
        pos[num] = [candidates[k].sx, candidates[k].sy];

        console.log('ar2track', candidates[k]);
        //console.log("selectTemplate", debugContent.selectTemplate[i]);
        debugContent.tracking2dSub[i].template = null;
        debugContent.tracking2dSub[i].templateCompute = null;
        console.log("tracking2dSub", debugContent.tracking2dSub[i]);
        _tracking2dSub({imageList, dpiList, modelViewProjectionTransform, candidate: candidates[k], debugSub: debugContent.tracking2dSub[i]});

        num += 1;
        if (num === 5) num = 0;
        i++;
      }
    }
  }
  return tracker;
};

const _tracking2dSub = ({imageList, dpiList, modelViewProjectionTransform, candidate, debugSub}) => {
  const image = imageList[candidate.level];
  const xsize = image.width;
  const ysize = image.height;
  const dpi = dpiList[candidate.level];
  const {mx, my} = candidate;
  const tsize = AR2_DEFAULT_TS * 2 + 1;
  const {template, validNum: templateValidNum, vlen: templateVlen, sum: templateSum} = _setTemplate({image, dpi, modelViewProjectionTransform, mx, my, debugSub});

  if (vlen * vlen < tsize * tsize * AR2_DEFAULT_TRACKING_SD_THRESH * AR2_DEFAULT_TRACKING_SD_THRESH) return;

  // search points
  const search = [];
  const u = computeScreenCoordiate(modelViewProjectionTransform, mx, my, 0);
  const sx = u.x;
  const sy = u.y;
  search.push([sx, sy]);
  // TODO previous two frames

  // get best matching
  const mfImage = [];
  for (let j = 0; j < image.height; j++) {
    mfImage.push([]);
    for (let i = 0; i < image.width; i++) {
      mfImage[j].push(null);
    }
  }

  const rx = AR2_SEARCH_SIZE;
  const ry = AR2_SEARCH_SIZE;
  for (let n = 0; n < searches.length; n++) {
     // "Snap" position to centre of grid square.
    const px = (search[n][0]/(SKIP_INTERVAL + 1))*(SKIP_INTERVAL + 1) + (SKIP_INTERVAL + 1)/2;
    const py = (search[n][1]/(SKIP_INTERVAL + 1))*(SKIP_INTERVAL + 1) + (SKIP_INTERVAL + 1)/2;

    let sx = px - rx; // Start position in x.
    if( sx < 0 ) sx = 0;
    let ex = px + rx; // End position in x.
    if( ex >= xsize ) ex = xsize - 1;

    let sy = py - ry; // Start position in y.
    if( sy < 0 ) sy = 0;
    let ey = py + ry; // End position in y.
    if( ey >= ysize ) ey = ysize - 1;

    // Initialise mfImage by writing 0s into the potential search space.
    for (let j = sy; j <= ey; j++ ) {
      for (let i = sx; i <= ex; i++ ) {
        mfImage[j * image.width + i] = 0;
      }
    }
  }

  for (let n = 0; n < searches.length; n++) {
    if( search_flag[ii] == 0 ) continue;
    if( search[ii][0] < 0 ) {
        if( ret ) return -1; // If we haven't got at least one starting point for a search, bail out.
        else    break;
    }

    const px = (search[n][0]/(SKIP_INTERVAL + 1))*(SKIP_INTERVAL + 1) + (SKIP_INTERVAL + 1)/2;
    const py = (search[n][1]/(SKIP_INTERVAL + 1))*(SKIP_INTERVAL + 1) + (SKIP_INTERVAL + 1)/2;

    const keepCandidates = [];
    for (let j = py - ry; j <= py + ry; j += SKIP_INTERVAL + 1 ) {
      if( j - AR2_DEFAULT_TS * AR2_TEMP_SCALE <  0     ) continue;
      if( j + AR2_DEFAULT_TS * AR2_TEMP_SCALE >= ysize ) break;

      for(let i = px - rx; i <= px + rx; i += SKIP_INTERVAL + 1 ) {
        if( i - AR2_DEFAULT_TS * AR2_TEMP_SCALE <  0     ) continue;
        if( i + AR2_DEFAULT_TS * AR2_TEMP_SCALE >= xsize ) break;

        if( mfImage[ j * xsize + i] === 1) continue; // Skip pixels already matched.
        mfImage[j * xsize + i] = 1; // Mark this pixel as matched.

        let sum1 = 0;
        let sum2 = 0;
        let sum3 = 0;
        for (let jj = -AR2_DEFAULT_TS; jj <= AR2_DEFAULT_TS; jj++) {
          for (let ii = -AR2_DEFAULT_TS; ii <= AR2_DEFAULT_TS; ii++) {
            const templateIndex = (jj + AR2_DEFAULT_TS) * tsize + (ii + AR2_DEFAULT_TS);
            const index = (j + jj * AR2_TEMP_SCALE) * xsize + (i + ii * AR2_TEMP_SCALE);
            if (template[templateIndex] !== null) {
              sum1 += image[index];
              sum2 += image[index] * image[index];
              sum3 += image[index] * templateIndex[index];
            }
          }
        }
        sum3 -= sum1 * templateSum / templateValidNum;
        const vlen = sum2 - sum1 * sum1 / templateValidNum;
        let wval = 0;
        if (vlen !== 0) {
          wval = sum3 * 100 / templateVlen * 100 / Math.floor(Math.sqrt(vlen));
        }

        keepCandidates.push({
          x: i,
          y: j,
          wval: wval
        })
      }
    }
  }
  keepCandidates.sort((c1, c2) => {return c2.wval , c1.wval});

  // Third pass. Determine best candidate.

}

const _setTemplate = ({image, dpi, modelViewProjectionTransform, mx, my, debugSub}) => {
  const u = computeScreenCoordiate(modelViewProjectionTransform, mx, my, 0);
  const sx = Math.floor(u.x + 0.5);
  const sy = Math.floor(u.y + 0.5);

  console.log("_setTemplate", mx, my, u, sx, sy);

  const tsize = AR2_DEFAULT_TS;

  const template = [];
  for (let j = 0; j <= tsize * 2; j++) {
    template.push([]);
    for (let i = 0; i <= tsize * 2; i++) {
      template[j].push(null);
    }
  }

  let sum = 0.0;
  let sum2 = 0.0;
  let k = 0;
  let debugIndex = 0;
  for (let j = -tsize; j <= tsize; j++) {
    const sy2 = sy + j * AR2_TEMP_SCALE;
    for (let i = -tsize; i <= tsize; i++) {
      const sx2 = sx + i * AR2_TEMP_SCALE;

      const {x: mx2, y: my2} = screenToMarkerCoordinate(modelViewProjectionTransform, sx2, sy2);

      const ix = Math.floor(mx2 * dpi / 25.4 + 0.5);
      const iy = Math.floor(image.height - my2 * dpi / 25.4 + 0.5);
      if (ix < 0 || ix >= image.width) continue;
      if (iy < 0 || iy >= image.height) continue;

      const pixel = image.data[iy * image.width + ix];
      //console.log("get pixel", sx2, sy2, pixel, debugSub.template[debugIndex++]);

      template[j+tsize][i+tsize] = pixel;
      sum += pixel;
      sum2 += pixel * pixel;
      k += 1;
    }
  }

  const vlen = Math.sqrt(sum2 - sum * sum / k);
  console.log("vlen: ", vlen, "sum: ", sum, "sum2: ", sum2, "k: ", k);
  return {
    template,
    vlen,
    sum,
    validNum: k
  }
}

const _selectTemplate = ({pos, prevFeatures, candidates, num, xsize, ysize}) => {
  if (num === 0) {
    let dmax = 0.0;
    let index = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].flag) continue;
      if (candidates[i].sx < xsize/8 || candidates[i].sx > xsize*7/8) continue;
      if (candidates[i].sy < ysize/8 || candidates[i].sy > ysize*7/8) continue;
      const d = (candidates[i].sx - xsize/2) * (candidates[i].sx - xsize/2)
              + (candidates[i].sy - ysize/2) * (candidates[i].sy - ysize/2);
      if (d > dmax) {
        dmax = d;
        index = i;
      }
    }
    console.log("selectTemplate", num, dmax, index);
    return index;
  }
  else if (num === 1) {
    let dmax = 0.0;
    let index = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].flag) continue;
      if (candidates[i].sx < xsize/8 || candidates[i].sx > xsize*7/8) continue;
      if (candidates[i].sy < ysize/8 || candidates[i].sy > ysize*7/8) continue;

      const d = (candidates[i].sx - pos[0][0]) * (candidates[i].sx - pos[0][0])
              + (candidates[i].sy - pos[0][1]) * (candidates[i].sy - pos[0][1]);
      if (d > dmax) {
        dmax = d;
        index = i;
      }
    }
    console.log("selectTemplate", num, dmax, index);
    return index;
  }
  else if (num === 2) {
    let dmax = 0.0;
    let index = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].flag) continue;
      if (candidates[i].sx < xsize/8 || candidates[i].sx > xsize*7/8) continue;
      if (candidates[i].sy < ysize/8 || candidates[i].sy > ysize*7/8) continue;

      let d = (candidates[i].sx - pos[0][0]) * (pos[1][1] - pos[0][1])
              - (candidates[i].sy - pos[0][1]) * (pos[1][0] - pos[0][0]);
      d = d * d;
      if (d > dmax) {
        dmax = d;
        index = i;
      }
    }
    console.log("selectTemplate", num, dmax, index);
    return index;
  }
  else if (num === 3) {
    const {sin: p2sin, cos: p2cos} = _getVectorAngle(pos[0], pos[1]);
    const {sin: p3sin, cos: p3cos} = _getVectorAngle(pos[0], pos[2]);

    let smax = 0.0;
    let index = -1;

    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].flag) continue;
      if (candidates[i].sx < xsize/8 || candidates[i].sx > xsize*7/8) continue;
      if (candidates[i].sy < ysize/8 || candidates[i].sy > ysize*7/8) continue;

      const cPos = [candidates[i].sx, candidates[i].sy];
      const {sin: p4sin, cos: p4cos} = _getVectorAngle(pos[0], cPos);

      let q1, r1, r2;
      if(((p3sin*p2cos - p3cos*p2sin) >= 0.0) && ((p4sin*p2cos - p4cos*p2sin) >= 0.0)) {
        if( p4sin*p3cos - p4cos*p3sin >= 0.0 ) {
          q1 = pos[1]; r1 = pos[2]; r2 = cPos;
        }
        else {
          q1 = pos[1]; r1 = cPos; r2 = pos[2];
        }
      }
      else if(((p4sin*p3cos - p4cos*p3sin) >= 0.0) && ((p2sin*p3cos - p2cos*p3sin) >= 0.0)) {
        if( p4sin*p2cos - p4cos*p2sin >= 0.0 ) {
          q1 = pos[2]; r1 = pos[1]; r2 = cPos;
        }
        else {
          q1 = pos[2]; r1 = cPos; r2 = pos[1];
        }
      }
      else if(((p2sin*p4cos - p2cos*p4sin) >= 0.0) && ((p3sin*p4cos - p3cos*p4sin) >= 0.0)) {
        if( p3sin*p2cos - p3cos*p2sin >= 0.0 ) {
          q1 = cPos; r1 = pos[1]; r2 = pos[2];
        }
        else {
          q1 = cPos; r1 = pos[2]; r2 = pos[1];
        }
      }
      else continue;

      const s = _getRegionArea(pos[0], q1, r1, r2);

      if( s > smax ) {
        smax = s;
        index = i;
      }
    }
    console.log("selectTemplate", num, smax, index);
    return index;
  }
  else {
    for (let i = 0; i < prevFeatures.length; i++) {
      for (let j = 0; j < candidates.length; j++) {
        if (candidates[j].flag) continue;

        if (prevFeatures[i].snum === candidates[j].snum
          && prevFeatures[i].level === candidates[j].level
          && prevFeatures[i].num === candidates[j].num) {
          return j;
        }
      }
    }

    let available = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (!candidates[i].flag)  available += 1;
    }
    let pick = Math.floor(Math.random() * available);
    for (let i = 0; i < candidates.length; i++) {
      if (!candidates[i].flag) {
        if (pick === 0) {
          return i;
        } else {
          pick -= 1;
        }
      }
    }
  }
  return -1;
}

const _getVectorAngle = (p1, p2) => {
  const l = Math.sqrt( (p2[0]-p1[0])*(p2[0]-p1[0]) + (p2[1]-p1[1])*(p2[1]-p1[1]) );
  return {
    sin: (p2[1] - p1[1]) / l,
    cos: (p2[0] - p1[0]) / l
  }
}

const _getRegionArea = (p1, p2, p3, p4) => {
  const s = _getTriangleArea(p1, p2, p3)
          + _getTriangleArea(p1, p3, p4);
  return s;
}

const _getTriangleArea = (p1, p2, p3) => {
  const x1 = p2[0] - p1[0];
  const y1 = p2[1] - p1[1];
  const x2 = p3[0] - p1[0];
  const y2 = p3[1] - p1[1];

  const s = 1.0 * (x1 * y2 - x2 * y1) / 2.0;
  return Math.abs(s);
}


module.exports = {
  createTracker
}