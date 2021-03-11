<template>
  <!-- TODO 待优化：多选时未上传成功的文件也会在成功列表内，需要过滤（单独处理） -->
  <div class="lg_upload_file">
    <div class="file_select" @click="handleBeforeUpload">
      <slot></slot>
      <input ref="file" type="file" :accept="accept" :multiple="multiple" @change="handleChange" style="display:none" />
    </div>
    <slot name="tip"></slot>
    <div class="file_list" v-if="showFileList && uploadFileList && uploadFileList.length > 0">
      <div :class="['file_item', 'is-' + item.status, overIndex === index ? 'focusing' : '']" v-for="(item, index) in uploadFileList" :key="index">
        <div class="file_item_box" @mouseover="overIndex = index" @mouseleave="overIndex = null" @click="overIndex = index">
          <div class="file_left">
            <p @click="handlePreview(item, index)">{{ item.fullName }}</p>
            <el-progress v-if="item.status === 'uploading'" :percentage="parseInt(item.percent)"></el-progress>
          </div>
          <div class="file_right">
            <p v-if="item.status === 'uploading'">{{ getSpeed(item.speed, item) }}</p>
            <i v-if="overIndex === index" class="upload_close el-icon-close" @click="handleRemove(item, index)"></i>
            <template v-else>
              <i v-if="item.status === 'success'" class="upload_success el-icon-circle-check"></i>
              <i v-else-if="item.status === 'fail'" class="upload_fail el-icon-warning-outline"></i>
              <i v-else style="width: 14px;height: 14px;display: inline-block;"></i>
            </template>
          </div>
        </div>
        <div class="file_item_error" v-if="item.status === 'fail'">{{ item.message }}</div>
      </div>
    </div>
  </div>
</template>
<script>
import { warning } from '@/utils/tips'
import { getQiniuToken } from '@/api/teaching/index'
import * as qiniu from 'qiniu-js'
export default {
  name: 'UploadFile',
  props: {
    accept: String, // 类型
    multiple: Boolean, // 多选
    disabled: Boolean, // 禁止上传
    limit: Number, // 个数
    size: Number, // 大小
    duration: Number, // 时长
    bitrate: Number, // 码率
    imageRatio: Array, // 图片比例
    category: String, // 接口上传类型
    showFileList: {
      type: Boolean,
      default: true
    },
    fileList: {
      type: Array,
      default() {
        return []
      }
    },
    beforeUpload: Function, // 上传前钩子
    onSuccess: {
      type: Function,
      default: function() {}
    },
    onProgress: {
      type: Function,
      default: function() {}
    },
    onError: {
      type: Function,
      default: function() {}
    }
  },
  data() {
    return {
      uploadFileList: [],
      tempIndex: 1,
      overIndex: null,
      focusing: true
    }
  },
  watch: {
    fileList: {
      immediate: true,
      handler(fileList) {
        this.uploadFileList = fileList.map(item => {
          item.uid = item.uid || Date.now() + this.tempIndex++
          item.status = item.status || 'success'
          return item
        })
      }
    }
  },
  methods: {
    /* 上传之前与文件无关的钩子函数 */
    handleBeforeUpload() {
      if (this.disabled) return
      this.$refs.file.click()
      if (!this.beforeUpload) {
        this.$refs.file.click()
        return
      }
      const before = this.beforeUpload()
      if (before && before.then) {
        before.then(() => {
          this.$refs.file.click()
        })
      } else if (before !== false) {
        this.$refs.file.click()
      } else {
        return
      }
    },
    /* 选择文件 */
    handleChange(event) {
      const files = event.target.files
      if (!files) return
      this.handleFiles(files)
    },
    handleFiles(files) {
      if (this.limit && this.fileList.length + files.length > this.limit) {
        warning('最多上传' + this.limit + '个文件，请删除重试！')
        this.$refs.file.value = null
        return
      }
      let postFiles = Array.prototype.slice.call(files)
      if (!this.multiple) {
        postFiles = postFiles.slice(0, 1)
      }
      if (postFiles.length === 0) {
        return
      }
      /* 上传文件列表 */
      postFiles.forEach(rawFile => {
        if (this.size && rawFile.size / 1024 / 1024 > this.size) {
          if (!this.multiple) {
            warning('文件大小不能超过' + this.handleSize(rawFile.size))
            this.$refs.file.value = null
          } else {
            this.uploadFileList.push({
              fullName: rawFile.name,
              size: rawFile.size,
              status: 'fail',
              message: '文件大小不能超过' + this.handleSize(rawFile.size),
              uid: Date.now() + this.tempIndex++
            })
          }
        } else {
          Promise.all([this.handleImageRatio(rawFile), this.handleDuraionOrBitrate(rawFile)])
            .then(() => {
              let fileObj = {
                status: 'uploading',
                message: '',
                size: rawFile.size,
                fullName: rawFile.name,
                subscription: null,
                timmer: null,
                loaded: 0,
                beforeLoaded: 0,
                speed: '',
                sizeList: [],
                percent: 0,
                uid: Date.now() + this.tempIndex++
              }
              this.uploadFileList.push(fileObj)
              this.upload(rawFile, fileObj)
                .then(obj => {
                  const index = this.uploadFileList.findIndex(e => e.uid === obj.uid)
                  this.$set(this.uploadFileList, index, obj)
                })
                .catch(error => {})
            })
            .catch(() => {
              if (!this.multiple) {
                warning(rawFile.message)
                this.$refs.file.value = null
              } else {
                this.uploadFileList.push({
                  fullName: rawFile.name,
                  size: rawFile.size,
                  status: rawFile.status,
                  message: rawFile.message,
                  uid: Date.now() + this.tempIndex++
                })
              }
            })
        }
      })
    },
    upload(file, fileObj) {
      return new Promise((resolve, reject) => {
        getQiniuToken(file.name, this.category).then(res => {
          if (res.code === 200) {
            const token = res.data.token
            const key = res.data.fileKey
            let config = {
              // 表示是否使用 cdn 加速域名，为布尔值，true 表示使用，默认为 false。
              useCdnDomain: true,
              // 根据具体提示修改上传地区,当为 null 或 undefined 时，自动分析上传域名区域
              // region: data.domain,
              // 分片上传的并发请求量，number，默认为3
              concurrentRequestLimit: 3
            }
            let putExtra = {
              // 文件原文件名
              fname: file.name,
              // 是否禁用日志报告
              disableStatisticsReport: true,
              // 用来放置自定义变量
              params: {},
              // 用来限制上传文件类型，为 null 时表示不对文件类型限制；限制类型放到数组里： ["image/png", "image/jpeg", "image/gif"]
              mimeType: null
            }
            let observable = qiniu.upload(file, key, token, putExtra, config)
            this.getLoadingSpeed(fileObj)
            fileObj.subscription = observable.subscribe({
              next: ({ total }) => {
                fileObj.status = 'uploading'
                fileObj.loaded = total.loaded
                fileObj.percent = total.percent
                this.handleProgress()
              },
              error: error => {
                if (!this.multiple) {
                  warning('上传失败！')
                  this.$refs.file.value = null
                } else {
                  fileObj.status = 'fail'
                  fileObj.message = '上传失败，请删除重试！'
                  resolve(fileObj)
                  this.handleError()
                }
              },
              complete: res => {
                fileObj.status = 'success'
                fileObj.fileKey = res.data.fileKey
                fileObj.fileUrl = res.data.fileUrl
                window.clearInterval(fileObj.timmer)
                this.onSuccess && this.onSuccess(this.uploadFileList)
                // if (!this.multiple) {
                //   this.onSuccess && this.onSuccess(this.uploadFileList)
                // } else {
                //   this.handleSuccess()
                // }
              }
            })
            this.$refs.file.value = null
            resolve(fileObj)
          } else {
            if (!this.multiple) {
              warning('上传失败！')
              this.$refs.file.value = null
            } else {
              fileObj.status = 'fail'
              fileObj.message = '上传失败，请删除重试！'
              resolve(fileObj)
              this.handleError()
            }
          }
        })
      })
    },
    /* 处理图片比例 */
    handleImageRatio(file) {
      if (!this.imageRatio || (this.imageRatio && this.imageRatio.length === 0) || file.type.toLowerCase().indexOf('image') < 0) {
        return new Promise(resolve => {
          resolve()
        })
      }
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        const image = new Image()
        image.onload = () => {
          let isMatch = false
          this.imageRatio.forEach(ratio => {
            const arr = ratio.split(':')
            if (image.width * parseInt(arr[0]) === image.height * parseInt(arr[1])) {
              isRatio = true
            }
          })
          if (isRatio) {
            resolve()
          } else {
            file.status = 'fail'
            file.message = '图片有误，仅支持' + this.imageRatio.join('、') + '！'
            reject()
          }
        }
        reader.onload = e => {
          image.src = e.target.result
        }
        reader.readAsDataURL(file)
      })
    },
    /* 处理时长、码率 */
    handleDuraionOrBitrate(file) {
      const noType = file.type.toLowerCase().indexOf('vedio') < 0 && file.type.toLowerCase().indexOf('audio') < 0
      const noCheck = !this.duration && !this.bitrate
      if (noType || noCheck) {
        return new Promise(resolve => {
          resolve()
        })
      }
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file)
        const audioElement = new Audio(url)
        audioElement.addEventListener('loadedmetadata', _event => {
          file.duration = parseInt(audioElement.duration)
          if (this.duration && file.duration > this.duration) {
            file.status = 'fail'
            file.message = '时长不可大于' + this.duration / 60 + '分钟！'
            reject()
          } else if (this.bitrate && ((file.size / 1024) * 8) / file.duration > this.bitrate) {
            file.status = 'fail'
            file.message = '码率不可大于' + this.bitrate + 'kpb/s'
            reject()
          } else {
            resolve()
          }
        })
      })
    },
    // 计算加载速度
    getLoadingSpeed(fileObj) {
      fileObj.timmer = setInterval(() => {
        let size = fileObj.loaded - fileObj.beforeLoaded
        fileObj.beforeLoaded = fileObj.loaded
        let length = fileObj.sizeList.length
        if (length >= 10) {
          fileObj.sizeList.splice(0, 1)
        }
        fileObj.sizeList.push(size)
        let sectionSize = fileObj.sizeList.reduce((a, b) => a + b)
        if (sectionSize === 0 || length === 0) {
          fileObj.speed = 0
        } else {
          fileObj.speed = sectionSize / (length * 0.5)
        }
      }, 500)
    },
    /* 上传中 */
    handleProgress() {
      const fileList = this.uploadFileList.filter(e => e.status === 'uploading')
      this.onProgress && this.onProgress(fileList)
    },
    /* 上传成功 */
    handleSuccess() {
      if (this.uploadFileList.findIndex(e => e.status === 'uploading') < 0) {
        this.onSuccess && this.onSuccess(this.uploadFileList)
      }
    },
    /* 上传失败 */
    handleError() {
      const fileList = this.uploadFileList.filter(e => e.status === 'fail')
      this.onError && this.onError(fileList)
    },
    /* 删除文件 */
    handleRemove(fileObj, index) {
      if (fileObj.subscription) {
        fileObj.subscription.unsubscribe()
      }
      if (fileObj.timmer) {
        window.clearInterval(fileObj.timmer)
      }
      this.uploadFileList.splice(index, 1)
      this.onSuccess && this.onSuccess(this.uploadFileList)
    },
    /* 预览 */
    handlePreview(fileObj) {
      if (fileObj.status === 'success') {
        window.open(fileObj.fileUrl)
      }
    },
    /* 处理文件大小 */
    handleSize(size) {
      if (this.size / 1024 >= 1) {
        return this.size / 1024 + 'GB'
      } else {
        return this.size + 'MB'
      }
    },
    /* 获取上传状态 */
    getStatus() {
      const failIndex = this.uploadFileList.findIndex(e => e.status === 'fail')
      const loadIndex = this.uploadFileList.findIndex(e => e.status === 'uploading')
      if (failIndex >= 0) {
        return 'fail'
      }
      if (loadIndex >= 0) {
        return 'uploading'
      }
      return 'success'
    },
    /* 清空所有正在上传 */
    abort() {
      this.uploadFileList.forEach(file => {
        if (file.status === 'uploading' && file.subscription) {
          file.subscription.unsubscribe()
        }
        if (file.status === 'uploading' && file.timmer) {
          window.clearInterval(file.timmer)
        }
      })
    },
    getSpeed(speed, file) {
      if (speed === '' && file.size / 1024 / 1024 > 10) {
        return '准备中...'
      }
      if (!speed && speed !== 0) {
        return ''
      }
      return this.formatFileSize(speed) + '/s'
    },
    formatFileSize(fileSize, fixed = 2) {
      if (fileSize === '') {
        return ''
      }
      if (fileSize < 1024) {
        return fileSize.toFixed(fixed) + ' B'
      } else if (fileSize < 1024 * 1024) {
        let temp = fileSize / 1024
        temp = temp.toFixed(fixed)
        return temp + ' KB'
      } else if (fileSize < 1024 * 1024 * 1024) {
        let temp = fileSize / (1024 * 1024)
        temp = temp.toFixed(fixed)
        return temp + ' MB'
      } else {
        let temp = fileSize / (1024 * 1024 * 1024)
        temp = temp.toFixed(fixed)
        return temp + ' GB'
      }
    }
  },
  destroyed() {
    // 销毁文件取消所有上传
    this.abort()
  }
}
</script>
<style lang="scss" scoped>
.lg_tip {
  font-size: 12px;
  color: #606266;
  line-height: 20px;
}
.file_select {
  display: inline-block;
  line-height: 1;
}
.file_list {
  display: flex;
  flex-wrap: wrap;
  margin-top: 5px;
  width: 100%;
  line-height: 1;
  .file_item {
    width: 100%;
    margin-bottom: 10px;
    &:last-child {
      margin-bottom: 0;
    }
    &.focusing {
      background-color: #f5f7fa;
    }
    .file_item_box {
      position: relative;
      display: flex;
      justify-content: space-between;
      align-items: center;
      width: 100%;
      padding: 0 10px;
      box-sizing: border-box;
      color: #606266;
      .file_left {
        width: calc(100% - 80px);
        p {
          width: 100%;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
          line-height: 30px;
          color: #606266;
          cursor: pointer;
        }
      }
      .file_right {
        width: 80px;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        p {
          font-size: 12px;
          line-height: 30px;
          color: #606266;
        }
        .upload_close {
          cursor: pointer;
          opacity: 0.75;
          &:hover {
            opacity: 1;
          }
        }
        .upload_success {
          color: #67c23a;
        }
        .upload_fail {
          color: #f56c6c;
        }
      }
    }
    .file_item_error {
      color: #f56c6c;
      font-size: 12px;
      line-height: 20px;
      padding: 0 10px;
    }
  }
}
</style>
