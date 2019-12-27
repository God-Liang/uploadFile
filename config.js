//OSS地址
let fileHost = '';

let config = {
	// 默认存在根目录，可根据需求改
	uploadImageUrl: `${fileHost}`,
	// AccessKeySecret 阿里云控制台上
	AccessKeySecret: '',
	// AccessKeyId 阿里云控制台上
	OSSAccessKeyId: '',
	//这个是上传文件时Policy的失效时间
	timeout: 87600
};

module.exports = config
