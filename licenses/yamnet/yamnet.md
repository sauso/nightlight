# YAMNet model attribution

Nightlight uses Google's YAMNet model, trained on AudioSet and licensed under Apache-2.0.
The ONNX conversion is from `andrelgomes/yamnet-onnx` at commit
`8a03a1572569685c42fdbef54ff36435dbaaf689`. The class map is from
`tensorflow/models` at commit `dfffd623b6be8d1d9744b8e261fbac370d17c46d`.
Both files are used unmodified and run on the device only. The original Google
YAMNet model on TensorFlow Hub or Kaggle is the recovery source if either pinned
download disappears. See `LICENSE` for the Apache-2.0 text.
