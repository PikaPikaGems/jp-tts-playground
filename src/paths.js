// Where the page finds its models. This is the DEV version. `npm run build:deploy` writes a different copy of this
// file into deploy/ (sbv2: false). The voice (yomiage) is always in ./yomiage/ and the dictionary (wakachi) in ./wakachi/.
export const PATHS = {
  sbv2: true, // Style-BERT-VITS2 panel (needs ~500 MB of local model files, see README)
};
