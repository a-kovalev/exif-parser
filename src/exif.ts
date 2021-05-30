/**
 * See more: https://www.exif.org/Exif2-2.PDF
 *
 * Basic Structure of Compressed file
 * +------------------------------+----------------------------------------------------------+
 * | SOI (0xFFD8)                 | Start of Image                                           |
 * | APP1                         | Application Marker Segment 1(Exif Attribute Information) |
 * | APP2                         | Application Marker Segment 2(FlashPix Extension data)    |
 * | DQT                          | Quantization Table                                       |
 * | DHT                          | Huffman Table                                            |
 * | (DRI)                        | (Restart Interval)                                       |
 * | SOF                          | Frame Header                                             |
 * | SOS                          | Scan Header                                              |
 * |                              | Compressed Data                                          |
 * | EOI (0xFFD9 )                | End of Image                                             |
 * +------------------------------+----------------------------------------------------------+
 *
 * Structure of APP1
 * +----------------------------------------------------------+
 * | APP1 Marker (0xFFE1)                                     |
 * | APP1 Length                                              |
 * | Exif Identifier Code (0x45786966 equals "Exif" in ASCII) |
 * | Pad 0x0000                                               |
 * | TIFF Header                                              |
 * | 0th IFD                                                  |
 * | 0th IFD Value                                            |
 * | 1st IFD                                                  |
 * | 1st IFD Value                                            |
 * | 1st IFD Image Data                                       |
 * +----------------------------------------------------------+
 *
 * Structure of TIFF Header (can be reverse byte order)
 * +----------------+------------+---------------+
 * |                | BIG ENDIAN | LITTLE ENDIAN |
 * +----------------+------------+---------------+
 * | Byte Order     | 0x4D4D     | 0x4949        |
 * | 42             | 0x2A00     | 0x002A        |
 * | 0th IFD Offset | 0x08000000 | 0x00000008    |
 * +----------------+------------+---------------+
 *
 * Structure of IFDs is large, see (page 110):
 * https://www.exif.org/Exif2-2.PDF
 *
 * Marker format:
 * +------------------------------+---------+----------------+
 * |            Marker            | Length  |      Data      |
 * +------------------------------+---------+----------------+
 * | 2 bytes (0xFF + Marker Code) | 2 bytes | {Length} bytes |
 * +------------------------------+---------+----------------+
 * FYI: Length descriptor value includes itself
 *
 */

const MARKERS = {
  SIO: 0xFFD8,
  APP1: 0xFFE1,
  EIC: 0x45786966, // Word "Exif" in ASCII
  BYTE_ORDER_LITTLE_ENDIAN: 0x4949,
  BYTE_ORDER_BIG_ENDIAN: 0x4D4D,
  F42: 0x002A,
  IFD0_OFFSET: 0x00000008,
};

const TIFF_TAGS = {
  0x010E: "ImageDescription",
  0x010F: "Make",
  0x0110: "Model",
  0x0112: "Orientation",
  0x011A: "XResolution",
  0x011B: "YResolution",
  0x0128: "ResolutionUnit",
  0x0132: "DateTime",
  0x0213: "YCbCrPositioning",
  0x8298: "CopyRight",
  0x8769: "Exif IFD Pointer",
};

/**
 * JPEG Compressed (4:2:2) File JPEG Stream Description Sample
 * @param file
 */
export function parseExif(file: File|Blob) {
  return new Promise((resolve, reject) => {
    // APP1 segment must be in the first 64kb
    readImageAsBuffer(file, 64 * 1024, 0)
      .then((arrayBuffer) => {
        const dataView = new DataView(arrayBuffer);
        const length = arrayBuffer.byteLength;
        let offset = 0;

        // Every JPEG file starts from the SIO marker
        if (dataView.getUint16(offset) !== MARKERS.SIO) {
          reject('Wrong JPEG');
          return;
        }

        // Offset SIO
        offset += 2;

        // APP1-segment search
        while (offset < length) {
          if (dataView.getUint8(offset) !== 0xFF) {
            reject('Wrong marker');
            return;
          }

          const segmentType = dataView.getUint16(offset);
          const segmentLength = dataView.getUint16(offset);

          if (segmentType === MARKERS.APP1) {
            resolve(parseAPP1Segment(dataView, offset));
            return;
          } else {
            // Skip segment
            offset += segmentLength;
          }
        }
      })
      .catch((err) => {
        reject(err);
      })
  });
}

function readImageAsBuffer(file: File|Blob, length?: number, offset = 0): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const fileReader = new FileReader();

    fileReader.onload = () => {
      const { result } = fileReader;

      if (typeof result === 'string' || result instanceof String) {
        reject(`File wrong type`);
        return;
      }

      resolve(result);
    };

    fileReader.onerror = () => {
      reject(`Error reading file`);
    };

    fileReader.readAsArrayBuffer(length ? file.slice(offset, length) : file);
  });
}

function parseAPP1Segment(dataView: DataView, offset: number) {
  // APP1 Marker (2 byte) + APP1 Length (2 byte)
  offset += 4;

  if (dataView.getUint32(offset) !== MARKERS.EIC) {
    return false;
  }

  // EIC (4 byte) + Zeros (2 byte)
  offset += 6;

  // Parse TIFF Header
  let isLittleEndian = false;
  if (dataView.getUint16(offset) === MARKERS.BYTE_ORDER_LITTLE_ENDIAN) {
    isLittleEndian = true;
  } else if (dataView.getUint16(offset) === MARKERS.BYTE_ORDER_BIG_ENDIAN) {
    isLittleEndian = false;
  } else {
    return false;
  }

  if (dataView.getUint16(offset + 2, isLittleEndian) !== MARKERS.F42) {
    return false;
  }

  const iFDOffset = dataView.getUint32(offset + 4, isLittleEndian);

  if (iFDOffset < MARKERS.IFD0_OFFSET) {
    return false;
  }

  return getTags(dataView, offset, iFDOffset, isLittleEndian);
}

function getTags(dataView: DataView, offset: number, iFDOffset: number, isLittleEndian: boolean) {
  const ifd0Offset = offset + iFDOffset;

  // Reading 0th IFD
  const countTags = dataView.getUint16(ifd0Offset, isLittleEndian);

  const entriesStartOffset = ifd0Offset + 2;
  const tags = {};

  for (let i = 0; i < countTags; i++) {
    // Every tag takes 12 bytes
    const tagOffset = entriesStartOffset + i * 12;
    const tag = TIFF_TAGS[dataView.getUint16(tagOffset, isLittleEndian)];

    if (!tag) {
      break;
    }

    tags[tag] = getTagValue(dataView, tagOffset, offset, ifd0Offset, isLittleEndian);
  }

  return tags;
}

function getTagValue(dataView: DataView, tagOffset: number, offset: number, ifd0Offset: number, isLittleEndian: boolean) {
  /**
   * 1 = BYTE An 8-bit unsigned integer.,
   * 2 = ASCII An 8-bit byte containing one 7-bit ASCII code. The final byte is terminated with NULL.,
   * 3 = SHORT A 16-bit (2-byte) unsigned integer,
   * 4 = LONG A 32-bit (4-byte) unsigned integer,
   * 5 = RATIONAL Two LONGs. The first LONG is the numerator and the second LONG expresses the denominator.,
   * 7 = UNDEFINED An 8-bit byte that can take any value depending on the field definition,
   * 9 = SLONG A 32-bit (4-byte) signed integer (2's complement notation),
   * 10 = SRATIONAL Two SLONGs. The first SLONG is the numerator and the second SLONG is the denominator.
   */
  const type = dataView.getUint16(tagOffset + 2, isLittleEndian);
  const count = dataView.getUint32(tagOffset + 4, isLittleEndian);
  const valueOffset = dataView.getUint32(tagOffset + 8, isLittleEndian) + offset;
  let dataOffset = 0;
  let value = null;

  switch (type) {
    case 2:
      dataOffset = count > 4 ? valueOffset : (tagOffset + 8);
      value = getStringFromBinaryCode(dataView, dataOffset, count - 1);
      break;
    case 3:
      value = dataView.getUint16(tagOffset + 8, isLittleEndian);
      break;
    case 4:
      value = dataView.getUint32(tagOffset + 8, isLittleEndian);
      break;
    case 5:
      const numerator = dataView.getUint32(valueOffset, isLittleEndian);
      const denominator = dataView.getUint32(valueOffset + 4, isLittleEndian);
      return {
        value: numerator / denominator,
        numerator: numerator,
        denominator: denominator,
      };
  }

  return value;
}

function getStringFromBinaryCode(dataView: DataView, start: number, length: number) {
  let result = '';
  for (let n = start; n < start + length; n++) {
    result += String.fromCharCode(dataView.getUint8(n));
  }
  return result;
}
